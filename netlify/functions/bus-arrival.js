const https = require('https');
const http  = require('http');

// 환경변수 전달 문제로 인한 403 의심 — 테스트를 위해 하드코딩
const TAGO_KEY = '294f26a66347876ed739424ad46a88193eebe24e6db958379ad9be23d7ca926a';
const SEOUL_BUS_KEY = '294f26a66347876ed739424ad46a88193eebe24e6db958379ad9be23d7ca926a';

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
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 간단한 XML 태그 추출 (의존성 없이 정규식으로 파싱)
function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`));
  return m ? m[1].trim() : '';
}

function xmlBlocks(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const blocks = [];
  let m;
  while ((m = re.exec(xml))) blocks.push(m[1]);
  return blocks;
}

// 서울시 버스도착정보 (정류소 고유ID(stId) 또는 정류소번호(arsId) 기반, 저상버스 도착정보 API)
async function fetchSeoulBusArrival(idParam, idValue, busNoArr) {
  const url =
    `http://ws.bus.go.kr/api/rest/arrive/getLowArrInfoByStId` +
    `?ServiceKey=${encodeURIComponent(SEOUL_BUS_KEY)}` +
    `&${idParam}=${encodeURIComponent(idValue)}`;

  console.log(`[bus-arrival] 서울시 버스 API 조회 시도 ${idParam}=${idValue}`);

  let raw;
  try {
    raw = await httpGet(url);
  } catch (e) {
    console.log(`[bus-arrival] 서울시 버스 API 조회 실패 ${idParam}=${idValue}:`, e.message);
    return null;
  }
  console.log(`[bus-arrival] 서울시 버스 API 응답(앞400) ${idParam}=${idValue}:`, raw.slice(0, 400));

  const headerCd = xmlTag(raw, 'headerCd');
  if (headerCd && headerCd !== '0') {
    console.log(`[bus-arrival] 서울시 버스 API 오류 ${idParam}=${idValue}:`, headerCd, xmlTag(raw, 'headerMsg'));
    return { list: [] };
  }

  const items = xmlBlocks(raw, 'itemList').map(block => ({
    routeNo: xmlTag(block, 'rtNm'),
    arrmsg1: xmlTag(block, 'arrmsg1'),
    arrmsg2: xmlTag(block, 'arrmsg2'),
  }));

  console.log(`[bus-arrival] 서울시 버스 API 결과 ${idParam}=${idValue}: ${items.length}건`, items[0] ? JSON.stringify(items[0]) : '');

  const filtered = busNoArr.length
    ? items.filter(i => busNoArr.includes(i.routeNo))
    : items;
  const finalItems = filtered.length ? filtered : items;

  const arrivals = finalItems
    .filter(i => i.arrmsg1)
    .map(i => ({ routeNo: i.routeNo, arrMsg: i.arrmsg1 }));

  return { list: arrivals };
}

// 도시코드: 1=서울, 11=경기, 31=부산, 36=인천 등
const CITY_CODES = [1, 11, 31, 36, 37, 38, 39];

// nodeId + cityCode로 실시간 도착정보 조회 (raw 응답 로깅 포함)
async function fetchArrivalList(nodeId, cityCode) {
  const arrUrl =
    `https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList` +
    `?serviceKey=${TAGO_KEY}` +
    `&cityCode=${cityCode}` +
    `&nodeId=${encodeURIComponent(nodeId)}` +
    `&numOfRows=10&_type=json`;

  console.log(`[bus-arrival] 도착정보 조회 시도 nodeId=${nodeId} cityCode=${cityCode}`);

  let raw;
  try {
    raw = await httpGet(arrUrl);
  } catch (e) {
    console.log(`[bus-arrival] 도착정보 조회 실패 nodeId=${nodeId} cityCode=${cityCode}:`, e.message);
    return null;
  }
  console.log(`[bus-arrival] 도착정보 응답(앞400) nodeId=${nodeId} cityCode=${cityCode}:`, raw.slice(0, 400));

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.log(`[bus-arrival] 도착정보 JSON 파싱 실패 nodeId=${nodeId} cityCode=${cityCode} (XML일 수 있음):`, raw.slice(0, 200));
    return null;
  }

  const resultCode = data?.response?.header?.resultCode;
  if (resultCode && resultCode !== '00') {
    console.log(`[bus-arrival] 도착정보 TAGO 오류 nodeId=${nodeId} cityCode=${cityCode}:`, resultCode, data?.response?.header?.resultMsg);
    return { list: [], totalCount: 0 };
  }

  const totalCount = data?.response?.body?.totalCount ?? 0;
  const items = data?.response?.body?.items?.item;
  const list = items ? (Array.isArray(items) ? items : [items]) : [];
  console.log(`[bus-arrival] 도착정보 결과 nodeId=${nodeId} cityCode=${cityCode}: totalCount=${totalCount} 건수=${list.length}`, list[0] ? '/ item[0]:' + JSON.stringify(list[0]) : '');
  return { list, totalCount };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const q = event.queryStringParameters || {};
  const { stationName, busNos, arsId, stationId, stationCityCode } = q;
  const directId = arsId || stationId || '';

  console.log('[bus-arrival] 요청:', { stationName, busNos, arsId, stationId, stationCityCode });

  if (!stationName) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'stationName 파라미터가 없습니다.' }),
    };
  }

  if (!TAGO_KEY) {
    return {
      statusCode: 503,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'TAGO_KEY 환경변수 미설정' }),
    };
  }

  if (!directId) {
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ arrivals: [], debug: `arsId/stationId 없음: ${stationName}` }),
    };
  }

  const busNoArr = busNos ? busNos.split(',').map(s => s.trim()).filter(Boolean) : [];

  try {
    // ── STEP -1: 서울시 버스도착정보 API. stId(=ODsay stationID) 먼저, 안 되면 arsId로 시도
    const seoulCandidates = [];
    if (stationId && stationId !== '0') seoulCandidates.push(['stId', stationId]);
    if (arsId && arsId !== '0') seoulCandidates.push(['arsId', arsId]);

    for (const [idParam, idValue] of seoulCandidates) {
      const seoulResult = await fetchSeoulBusArrival(idParam, idValue, busNoArr);
      if (seoulResult && seoulResult.list.length) {
        console.log(`[bus-arrival] ✅ 서울시 버스 API 성공 ${idParam}=${idValue} 건수=${seoulResult.list.length}`);
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ arrivals: seoulResult.list.slice(0, 3) }),
        };
      }
      console.log(`[bus-arrival] 서울시 버스 API 결과 없음 ${idParam}=${idValue}`);
    }

    let list = null;

    // arsId/stationId로 바로 도착정보 조회. stationCityCode가 있으면 그 값을 먼저 시도
    const cityCode0 = Number(stationCityCode);
    const cityCodes = !isNaN(cityCode0) && stationCityCode
      ? [cityCode0, ...CITY_CODES.filter(c => c !== cityCode0)]
      : CITY_CODES;

    console.log(`[bus-arrival] arsId/stationId 직접 사용 시도: nodeId=${directId}, cityCodes=${cityCodes}`);
    for (const cityCode of cityCodes) {
      const result = await fetchArrivalList(directId, cityCode);
      if (result && result.list.length) {
        list = result.list;
        console.log(`[bus-arrival] ✅ arsId/stationId 직접조회 성공 nodeId=${directId} cityCode=${cityCode} 건수=${list.length}`);
        break;
      }
    }

    if (!list) {
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ arrivals: [], debug: `no arrivals for nodeId=${directId}` }),
      };
    }

    console.log('[bus-arrival] item[0] 전체 필드:', JSON.stringify(list[0]));

    // 버스 번호 필터 (busNos가 있을 때)
    const filtered = busNoArr.length
      ? list.filter(i => busNoArr.some(b =>
          String(i.routeno) === b || String(i.routeNo) === b
        ))
      : list;

    const finalList = filtered.length ? filtered : list;
    console.log('[bus-arrival] 필터 후 건수:', finalList.length, '(busNos:', busNos, ')');

    // TAGO 필드명: routeno, arrprevstationcnt, arrtime (소문자)
    const arrivals = finalList.slice(0, 3).map(i => {
      const cnt  = i.arrprevstationcnt  ?? i.arrPrevStationCnt  ?? null;
      const time = i.arrtime            ?? i.arrTime            ?? null;
      const rno  = i.routeno || i.routeNo || '?';

      let arrMsg;
      if (cnt === 0 || time === 0) {
        arrMsg = '곧 도착';
      } else if (cnt != null && time != null) {
        arrMsg = `${cnt}정거장 전 (약 ${Math.ceil(Number(time) / 60)}분)`;
      } else if (time != null) {
        arrMsg = `약 ${Math.ceil(Number(time) / 60)}분 후`;
      } else if (cnt != null) {
        arrMsg = `${cnt}정거장 전`;
      } else {
        arrMsg = '정보 없음';
      }

      return { routeNo: rno, arrMsg };
    });

    console.log('[bus-arrival] 최종 arrivals:', JSON.stringify(arrivals));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ arrivals }),
    };

  } catch (err) {
    console.error('[bus-arrival] 예외:', err.message);
    return {
      statusCode: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'TAGO API 오류: ' + err.message }),
    };
  }
};
