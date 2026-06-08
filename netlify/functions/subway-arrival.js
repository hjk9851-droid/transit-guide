const http  = require('http');
const https = require('https');

const SUBWAY_KEY = process.env.SUBWAY_KEY || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function httpGet(url, timeoutMs = 15000) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, res => {
      console.log(`[subway] HTTP ${res.statusCode} ← ${url.replace(SUBWAY_KEY, '***')}`);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', e => {
      console.log(`[subway] 연결 실패: ${e.message} / URL: ${url.replace(SUBWAY_KEY, '***')}`);
      reject(e);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      console.log(`[subway] timeout (${timeoutMs}ms) / URL: ${url.replace(SUBWAY_KEY, '***')}`);
      reject(new Error(`timeout after ${timeoutMs}ms`));
    });
  });
}

// 역 이름 정제: "강남역(2호선)" → "강남"
function cleanName(name) {
  return name
    .replace(/\(.*?\)/g, '')    // 괄호 제거
    .replace(/\s+\d+호선$/, '') // " 2호선" 제거
    .replace(/역$/, '')          // "역" 제거
    .trim();
}

// 서울 지하철 실시간 API 시도 URL 목록 (우선순위 순)
function buildUrls(key, station) {
  const enc = encodeURIComponent(station);
  return [
    // 1. swopenapi HTTPS (Netlify에서 HTTP 차단 시 우회)
    `https://swopenapi.seoul.go.kr/api/subway/${key}/json/realtimeStationArrival/0/10/${enc}`,
    // 2. swopenapi HTTP (원래 공식 URL)
    `http://swopenapi.seoul.go.kr/api/subway/${key}/json/realtimeStationArrival/0/10/${enc}`,
    // 3. openapi 포털 HTTP (포트 8088)
    `http://openapi.seoul.go.kr:8088/${key}/json/realtimeStationArrival/0/10/${enc}`,
  ];
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const q = event.queryStringParameters || {};
  const { stationName, lineName } = q;

  console.log('[subway] 요청:', { stationName, lineName });

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

  const name = cleanName(stationName);
  console.log(`[subway] 정제된 역명: "${stationName}" → "${name}"`);

  const urls = buildUrls(SUBWAY_KEY, name);
  let raw = null;
  let lastErr = '';

  // URL을 순서대로 시도
  for (const url of urls) {
    try {
      console.log(`[subway] 시도: ${url.replace(SUBWAY_KEY, '***')}`);
      raw = await httpGet(url, 15000);
      console.log(`[subway] 응답 (앞300): ${raw.slice(0, 300)}`);
      break; // 성공하면 중단
    } catch (e) {
      lastErr = e.message;
      console.log(`[subway] 실패: ${e.message}`);
      raw = null;
    }
  }

  if (!raw) {
    console.log('[subway] 모든 URL 실패. lastErr:', lastErr);
    return {
      statusCode: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '지하철 API 모든 URL 실패: ' + lastErr }),
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.log('[subway] JSON 파싱 실패. 원본(앞200):', raw.slice(0, 200));
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ arrivals: [], debug: 'JSON parse fail: ' + raw.slice(0, 100) }),
    };
  }

  console.log('[subway] 파싱된 data 키:', Object.keys(data));

  // 오류 응답 처리
  if (data.errorMessage) {
    const code = data.errorMessage.status;
    const msg  = data.errorMessage.message || '';
    console.log(`[subway] API 오류 status=${code} msg="${msg}"`);
    if (code === 404 || code === 500 || msg.includes('해당하는 데이터가 없')) {
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ arrivals: [], debug: `errorMessage: ${code} ${msg}` }),
      };
    }
    // 인증 오류 등
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ arrivals: [], debug: `API error: ${code} ${msg}` }),
    };
  }

  const list = data.realtimeArrivalList || [];
  console.log(`[subway] realtimeArrivalList 건수: ${list.length}`);
  if (list.length > 0) {
    console.log('[subway] item[0]:', JSON.stringify(list[0]));
  }

  // 노선 필터
  const lineKey = lineName ? lineName.replace(/[호선]$/g, '').trim() : '';
  const filtered = lineKey
    ? list.filter(i => (i.trainLineNm || '').includes(lineKey) || (i.subwayId || '').includes(lineKey))
    : list;

  console.log(`[subway] 필터 후 건수: ${filtered.length} (lineKey="${lineKey}")`);

  const arrivals = (filtered.length ? filtered : list).slice(0, 4).map(i => ({
    trainLineNm: i.trainLineNm || lineName || '',
    arvlMsg2:    i.arvlMsg2   || '',
    arvlMsg3:    i.arvlMsg3   || '',
  }));

  console.log('[subway] 최종 arrivals:', JSON.stringify(arrivals));

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ arrivals }),
  };
};
