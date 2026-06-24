# S3 Speed Test

Simple S3 upload/download speed testing application running on Node.js.

## Requirements

* Ubuntu 22.04+
* Node.js 20+
* npm
* PM2

---

## Installation

Update packages:

```bash
sudo apt update
```

Install npm:

```bash
sudo apt install npm -y
```

Install PM2 globally:

```bash
sudo npm install -g pm2
```

Install Node.js 20:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

sudo apt-get install -y nodejs
```

Clone repository:

```bash
git clone https://github.com/zamasaki/s3-speedtest.git

cd s3-speedtest
```

Install dependencies:

```bash
npm install
```

---

## Environment Variables

Create `.env` from `.env.example`

```bash
cp .env.example .env
```

Edit:

```bash
nano .env
```

---

## Run Application

Start server:

```bash
node server.js
```

---

## PM2 Commands

Start:

```bash
pm2 start server.js --name "s3-speedtest"
```

Save:

```bash
pm2 save
```

View logs:

```bash
pm2 logs s3-speedtest --lines 10
```

Restart:

```bash
pm2 restart s3-speedtest
```

Stop:

```bash
pm2 stop s3-speedtest
```

Delete:

```bash
pm2 delete s3-speedtest
```

---

## Repository

```text
s3-speedtest/

├── public/
├── server.js
├── package.json
├── package-lock.json
├── .env.example
└── README.md
```

## License

MIT
