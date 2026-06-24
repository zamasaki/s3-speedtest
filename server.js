/**
 * S3 Speedtest — Backend (Client-side Thuần túy, Multi-Endpoint)
 * Backend CHỈ: sinh Presigned URL + xóa object sau test
 * Upload/download xảy ra TRỰC TIẾP browser ↔ S3
 *
 * Hỗ trợ NHIỀU S3 endpoint/profile cùng lúc — khai báo trong endpoints.json
 * Mỗi request (presign/delete) chỉ định profile muốn dùng qua tham số `endpoint`.
 */

import express    from 'express';
import path       from 'path';
import fs         from 'fs';
import { fileURLToPath } from 'url';
import dotenv     from 'dotenv';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    CreateMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    UploadPartCommand,
    DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 5000;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Load danh sách profile (endpoint) ───────────────────────────────────────
// Ưu tiên file endpoints.json (nhiều endpoint).
// Nếu không có file này, fallback về 4 biến .env cũ (1 endpoint) để tương thích ngược.
const CONFIG_PATH = process.env.S3_CONFIG_PATH || path.join(__dirname, 'endpoints.json');

function loadProfiles() {
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            if (!Array.isArray(raw) || !raw.length) throw new Error('endpoints.json trống/không hợp lệ');
            return raw.map(p => ({
                id:              p.id,
                label:           p.label || p.id,
                endpoint:        p.endpoint,
                region:          p.region || 'ap-southeast-1',
                bucket:          p.bucket,
                accessKeyId:     p.accessKeyId,
                secretAccessKey: p.secretAccessKey,
            }));
        } catch (e) {
            console.error('[config] Lỗi đọc endpoints.json:', e.message);
            process.exit(1);
        }
    }

    console.warn('[config] Không tìm thấy endpoints.json — dùng fallback từ .env (1 endpoint duy nhất).');
    return [{
        id:              'default',
        label:           process.env.AWS_BUCKET_NAME || 'default',
        endpoint:        process.env.S3_ENDPOINT     || "https://s3-hcm5-r1.longvan.net",
        region:          process.env.AWS_REGION      || "ap-southeast-1",
        bucket:          process.env.AWS_BUCKET_NAME || "tung-lvs",
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }];
}

const PROFILES   = loadProfiles();
const profileMap = new Map(PROFILES.map(p => [p.id, p]));
const clientCache = new Map(); // profileId -> S3Client

function getClient(profileId) {
    const p = profileMap.get(profileId);
    if (!p) {
        const err = new Error(`Endpoint không tồn tại: "${profileId}"`);
        err.statusCode = 400;
        throw err;
    }
    if (!clientCache.has(profileId)) {
        clientCache.set(profileId, new S3Client({
            region:   p.region,
            endpoint: p.endpoint,
            credentials: {
                accessKeyId:     p.accessKeyId,
                secretAccessKey: p.secretAccessKey,
            },
            forcePathStyle: true,
            requestChecksumCalculation: "WHEN_REQUIRED",
            responseChecksumValidation: "WHEN_REQUIRED",
        }));
    }
    return { s3: clientCache.get(profileId), bucket: p.bucket, profile: p };
}

// Lấy profileId người dùng chọn — query string (GET/DELETE) hoặc body (POST)
function resolveProfileId(req) {
    return req.query.endpoint || req.body?.endpoint || PROFILES[0].id;
}

const cleanUrl = (url) => url
    .replace(/[&?]x-amz-sdk-checksum-algorithm=[^&]*/gi, '')
    .replace(/[&?]x-amz-checksum-crc32=[^&]*/gi,         '')
    .replace(/[&?]x-amz-checksum-mode=[^&]*/gi,          '');

async function buildGetUrl(s3, bucket, key, expiresIn = 600) {
    return getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn }
    );
}

// Validate key — chỉ cho phép thao tác trên file speedtest tạm
const validKey = (key) => /^speedtest-\d+\.bin$/.test(key);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Ping ─────────────────────────────────────────────────────────────────────
app.get('/api/ping', (_req, res) => res.json({ pong: true, ts: Date.now() }));

// ── Danh sách endpoint khả dụng (KHÔNG trả access key / secret key) ─────────
app.get('/api/endpoints', (_req, res) => {
    res.json(PROFILES.map(p => ({
        id:       p.id,
        label:    p.label,
        endpoint: p.endpoint,
        bucket:   p.bucket,
        region:   p.region,
    })));
});

// ── Config (giữ lại để tương thích — trả info của endpoint được chọn) ────────
app.get('/api/config', (req, res) => {
    try {
        const profileId = resolveProfileId(req);
        const p = profileMap.get(profileId);
        if (!p) return res.status(400).json({ error: `Endpoint không tồn tại: ${profileId}` });
        res.json({ endpoint: p.endpoint, bucket: p.bucket, region: p.region, id: p.id, label: p.label });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Single PUT + GET ──────────────────────────────────────────────────────────
app.get('/api/presign/single', async (req, res) => {
    try {
        const profileId = resolveProfileId(req);
        const { s3, bucket } = getClient(profileId);

        const key = `speedtest-${Date.now()}.bin`;
        const uploadUrl   = cleanUrl(await getSignedUrl(s3,
            new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'application/octet-stream' }),
            { expiresIn: 600 }
        ));
        const downloadUrl = await buildGetUrl(s3, bucket, key, 600);
        res.json({ key, uploadUrl, downloadUrl, endpoint: profileId });
    } catch (err) {
        console.error('[presign/single]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// ── Multipart init ────────────────────────────────────────────────────────────
app.post('/api/presign/multipart/init', async (req, res) => {
    try {
        const { partCount } = req.body;
        const profileId = resolveProfileId(req);
        const { s3, bucket } = getClient(profileId);

        if (!partCount || partCount < 1 || partCount > 10000)
            return res.status(400).json({ error: 'partCount không hợp lệ' });

        const key = `speedtest-${Date.now()}.bin`;
        const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
            Bucket: bucket, Key: key, ContentType: 'application/octet-stream',
        }));

        const partUrls = await Promise.all(
            Array.from({ length: partCount }, (_, i) =>
                getSignedUrl(s3, new UploadPartCommand({
                    Bucket: bucket, Key: key, UploadId, PartNumber: i + 1,
                }), { expiresIn: 600 }).then(cleanUrl)
            )
        );

        const downloadUrl = await buildGetUrl(s3, bucket, key, 600);
        res.json({ key, uploadId: UploadId, partUrls, downloadUrl, endpoint: profileId });
    } catch (err) {
        console.error('[presign/multipart/init]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// ── Multipart complete ────────────────────────────────────────────────────────
app.post('/api/presign/multipart/complete', async (req, res) => {
    try {
        const { key, uploadId, parts } = req.body;
        const profileId = resolveProfileId(req);
        const { s3, bucket } = getClient(profileId);

        if (!key || !uploadId || !Array.isArray(parts) || !parts.length)
            return res.status(400).json({ error: 'Thiếu tham số' });

        await s3.send(new CompleteMultipartUploadCommand({
            Bucket: bucket, Key: key, UploadId: uploadId,
            MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
        }));

        const downloadUrl = await buildGetUrl(s3, bucket, key, 600);
        res.json({ ok: true, key, downloadUrl });
    } catch (err) {
        console.error('[presign/multipart/complete]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// ── Multipart abort ───────────────────────────────────────────────────────────
app.post('/api/presign/multipart/abort', async (req, res) => {
    try {
        const { key, uploadId } = req.body;
        const profileId = resolveProfileId(req);
        const { s3, bucket } = getClient(profileId);

        if (!key || !uploadId) return res.status(400).json({ error: 'Thiếu tham số' });
        await s3.send(new AbortMultipartUploadCommand({
            Bucket: bucket, Key: key, UploadId: uploadId,
        }));
        res.json({ ok: true });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// ── Xóa object sau khi test xong ─────────────────────────────────────────────
// Frontend gọi sau khi download hoàn tất để dọn file tạm trên S3.
// Chỉ cho phép xóa key đúng dạng speedtest-<timestamp>.bin
// Profile được chọn qua query string: /api/object/<key>?endpoint=<id>
app.delete('/api/object/:key', async (req, res) => {
    const key = decodeURIComponent(req.params.key);
    if (!validKey(key))
        return res.status(400).json({ error: 'Key không hợp lệ: ' + key });
    try {
        const profileId = resolveProfileId(req);
        const { s3, bucket } = getClient(profileId);
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        console.log(`[delete] [${profileId}] ${key}`);
        res.json({ ok: true, key });
    } catch (err) {
        console.error('[delete]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n  S3 Speedtest (multi-endpoint, client-side mode)`);
    console.log(`  URL    : http://localhost:${PORT}`);
    console.log(`  Endpoints khả dụng (${PROFILES.length}):`);
    PROFILES.forEach(p => console.log(`   - [${p.id}] ${p.label} → ${p.endpoint} (bucket: ${p.bucket})`));
    console.log('');
});
