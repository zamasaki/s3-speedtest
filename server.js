/**
 * S3 Speedtest — Backend (Client-side Thuần túy)
 * Backend CHỈ: sinh Presigned URL + xóa object sau test
 * Upload/download xảy ra TRỰC TIẾP browser ↔ S3
 */

import express    from 'express';
import path       from 'path';
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

const app      = express();
const PORT     = process.env.PORT            || 5000;
const BUCKET   = process.env.AWS_BUCKET_NAME || "tung-lvs";
const ENDPOINT = process.env.S3_ENDPOINT     || "https://s3-hcm5-r1.longvan.net";
const REGION   = process.env.AWS_REGION      || "ap-southeast-1";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const s3 = new S3Client({
    region:   REGION,
    endpoint: ENDPOINT,
    credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
});

const cleanUrl = (url) => url
    .replace(/[&?]x-amz-sdk-checksum-algorithm=[^&]*/gi, '')
    .replace(/[&?]x-amz-checksum-crc32=[^&]*/gi,         '')
    .replace(/[&?]x-amz-checksum-mode=[^&]*/gi,          '');

//async function buildGetUrl(key, expiresIn = 600) {
//    return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
//}
async function buildGetUrl(key, expiresIn = 600) {
    return getSignedUrl(
        s3,
        new GetObjectCommand({
            Bucket: BUCKET,
            Key: key
        }),
        { expiresIn }
    );
}

// Validate key — chỉ cho phép thao tác trên file speedtest tạm
const validKey = (key) => /^speedtest-\d+\.bin$/.test(key);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Ping ─────────────────────────────────────────────────────────────────────
app.get('/api/ping', (_req, res) => res.json({ pong: true, ts: Date.now() }));

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
    res.json({ endpoint: ENDPOINT, bucket: BUCKET, region: REGION });
});

// ── Single PUT + GET ──────────────────────────────────────────────────────────
app.get('/api/presign/single', async (req, res) => {
    try {
        const key = `speedtest-${Date.now()}.bin`;
        const uploadUrl   = cleanUrl(await getSignedUrl(s3,
            new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'application/octet-stream' }),
            { expiresIn: 600 }
        ));
        const downloadUrl = await buildGetUrl(key, 600);
        res.json({ key, uploadUrl, downloadUrl });
    } catch (err) {
        console.error('[presign/single]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Multipart init ────────────────────────────────────────────────────────────
app.post('/api/presign/multipart/init', async (req, res) => {
    try {
        const { partCount } = req.body;
        if (!partCount || partCount < 1 || partCount > 10000)
            return res.status(400).json({ error: 'partCount không hợp lệ' });

        const key = `speedtest-${Date.now()}.bin`;
        const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
            Bucket: BUCKET, Key: key, ContentType: 'application/octet-stream',
        }));

        const partUrls = await Promise.all(
            Array.from({ length: partCount }, (_, i) =>
                getSignedUrl(s3, new UploadPartCommand({
                    Bucket: BUCKET, Key: key, UploadId, PartNumber: i + 1,
                }), { expiresIn: 600 }).then(cleanUrl)
            )
        );

        const downloadUrl = await buildGetUrl(key, 600);
        res.json({ key, uploadId: UploadId, partUrls, downloadUrl });
    } catch (err) {
        console.error('[presign/multipart/init]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Multipart complete ────────────────────────────────────────────────────────
app.post('/api/presign/multipart/complete', async (req, res) => {
    try {
        const { key, uploadId, parts } = req.body;
        if (!key || !uploadId || !Array.isArray(parts) || !parts.length)
            return res.status(400).json({ error: 'Thiếu tham số' });

        await s3.send(new CompleteMultipartUploadCommand({
            Bucket: BUCKET, Key: key, UploadId: uploadId,
            MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
        }));

        const downloadUrl = await buildGetUrl(key, 600);
        res.json({ ok: true, key, downloadUrl });
    } catch (err) {
        console.error('[presign/multipart/complete]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Multipart abort ───────────────────────────────────────────────────────────
app.post('/api/presign/multipart/abort', async (req, res) => {
    try {
        const { key, uploadId } = req.body;
        if (!key || !uploadId) return res.status(400).json({ error: 'Thiếu tham số' });
        await s3.send(new AbortMultipartUploadCommand({
            Bucket: BUCKET, Key: key, UploadId: uploadId,
        }));
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Xóa object sau khi test xong ─────────────────────────────────────────────
// Frontend gọi sau khi download hoàn tất để dọn file tạm trên S3.
// Chỉ cho phép xóa key đúng dạng speedtest-<timestamp>.bin
app.delete('/api/object/:key', async (req, res) => {
    const key = decodeURIComponent(req.params.key);
    if (!validKey(key))
        return res.status(400).json({ error: 'Key không hợp lệ: ' + key });
    try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
        console.log(`[delete] ${key}`);
        res.json({ ok: true, key });
    } catch (err) {
        console.error('[delete]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n  S3 Speedtest (client-side mode)`);
    console.log(`  URL    : http://localhost:${PORT}`);
    console.log(`  Bucket : ${BUCKET}`);
    console.log(`  S3     : ${ENDPOINT}\n`);
});
