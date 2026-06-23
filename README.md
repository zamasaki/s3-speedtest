apt update
apt install npm -y
sudo npm install -y pm2 -g
sudo apt-get install -y curl
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
cd s3-speedtest
npm install
pm2 start server.js --name "s3-speedtest"
pm2 save
pm2 logs s3-speedtest --lines 10
pm2 delete s3-speedtest
