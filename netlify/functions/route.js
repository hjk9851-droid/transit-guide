const https = require('https');

const ODSAY_KEY = '1uM89IGEpUqe9u4vjV1kJw';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return Promise.resolve({ statusCode: 204, headers: CORS, body: '' });
  }

  const q = event.queryStringParameters || {};
  const { SX, SY, EX, EY } = q;

  if (!SX || !SY || !EX || !EY) {
    return Promise.resolve({
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { msg: '필수 파라미터(SX SY EX EY)가 없습니다.' } }),
    });
  }

  const url =
    'https://api.odsay.com/v1/api/searchPubTransPathT' +
    `?SX=${encodeURIComponent(SX)}&SY=${encodeURIComponent(SY)}` +
    `&EX=${encodeURIComponent(EX)}&EY=${encodeURIComponent(EY)}` +
    `&apiKey=${encodeURIComponent(ODSAY_KEY)}`;

  const options = {
    headers: {
      'Referer': 'https://heartfelt-griffin-2dc6c0.netlify.app/',
      'Origin':  'https://heartfelt-griffin-2dc6c0.netlify.app',
    },
  };

  return new Promise((resolve) => {
    const req = https.get(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
      res.on('error', (err) => {
        resolve({
          statusCode: 502,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: { msg: 'ODsay 응답 오류: ' + err.message } }),
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        statusCode: 502,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { msg: 'ODsay 연결 실패: ' + err.message } }),
      });
    });

    req.setTimeout(15000, () => {
      req.destroy();
      resolve({
        statusCode: 504,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { msg: 'ODsay 응답 시간 초과' } }),
      });
    });
  });
};
