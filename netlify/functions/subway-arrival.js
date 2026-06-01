const http  = require('http');
const https = require('https');

// Netlify 환경변수에 설정: SUBWAY_KEY
const SUBWAY_KEY = process.env.SUBWAY_KEY || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function httpGet(url) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 역 이름 정제 (API는 "강남" 형태로 요청)
function cleanName(name) {
  return name
    .replace(/\(.*?\)$/, '')   // 괄호 접미사 제거: "강남(2호선)" → "강남"
    .replace(/\s+\d+호선$/, '') // "강남역 2호선" → "강남역"
    .replace(/역$/, '')         // "강남역" → "강남"
    .trim();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const q = event.queryStringParameters || {};
  const { stationName, lineName } = q;

  if (!stationName) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'stationName 파라미터가 없습니다.' }),
    };
  }

  if (!SUBWAY_KEY) {
    return {
      statusCode: 503,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'SUBWAY_KEY 환경변수가 설정되지 않았습니다.' }),
    };
  }

  try {
    const name = cleanName(stationName);
    const url =
      `http://swopenapi.seoul.go.kr/api/subway/${encodeURIComponent(SUBWAY_KEY)}` +
      `/json/realtimeStationArrival/0/10/${encodeURIComponent(name)}`;

    const raw = await httpGet(url);
    const data = JSON.parse(raw);

    // 오류 응답 처리
    if (data.errorMessage) {
      const code = data.errorMessage.status;
      if (code === 404 || code === 500) {
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ arrivals: [] }),
        };
      }
    }

    const list = data.realtimeArrivalList || [];

    // 요청한 노선 필터 (예: "경의중앙선", "2호선")
    const filtered = lineName
      ? list.filter(i => i.subwayId && lineName && i.trainLineNm?.includes(lineName.replace(/호선|선/, '')))
      : list;

    const arrivals = (filtered.length ? filtered : list).slice(0, 4).map(i => ({
      trainLineNm: i.trainLineNm || i.subwayId,
      arvlMsg2:    i.arvlMsg2 || '',
      arvlMsg3:    i.arvlMsg3 || '',
    }));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ arrivals }),
    };

  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '지하철 API 오류: ' + err.message }),
    };
  }
};
