const https = require('https');
const http  = require('http');

// 환경변수 전달 문제로 인한 403 의심 — 테스트를 위해 하드코딩
const TAGO_KEY = '294f26a66347876ed739424ad46a88193eebe24e6db958379ad9be23d7ca926a';

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

// ODsay 정류장명 → TAGO 검색용 후보 목록
function nameVariants(name) {
  const cleaned = name
    .replace(/\s*\(.*?\)$/, '')           // "(앞)" 등 괄호 제거
    .replace(/\s*(버스\s*)?정류장?$/i, '') // "버스정류장" 접미사 제거
    .trim();

  const variants = [name, cleaned];

  // "." 포함 시 앞부분만 잘라서도 시도 (예: "배탈고개.일신건영아파트" → "배탈고개")
  for (const v of [name, cleaned]) {
    if (v.includes('.')) {
      const head = v.split('.')[0].trim();
      if (head) variants.push(head);
    }
  }

  return [...new Set(variants)].filter(Boolean);
}

// 도시코드: 서울(11) → 경기(31) — 너무 많은 조합 시도 시 Netlify 함수 타임아웃 발생하여 2개로 제한
const CITY_CODES = [11, 31];

// TAGO getSttnNoList로 nodeId 조회 (도시코드 + 이름 조합 순차 시도)
async function findNodeId(stationName) {
  const variants = nameVariants(stationName);
  console.log('[bus-arrival] nodeId 검색 시작:', { stationName, variants });

  for (const nm of variants) {
    for (const cityCode of CITY_CODES) {
      try {
        const url =
          `https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getSttnNoList` +
          `?serviceKey=${TAGO_KEY}` +
          `&cityCode=${cityCode}` +
          `&nodeNm=${encodeURIComponent(nm)}` +
          `&numOfRows=10&_type=json`;

        console.log(`[bus-arrival] 조회 시도 → URL: ${url.replace(TAGO_KEY, '***')}`);

        const raw = await httpGet(url);
        console.log(`[bus-arrival] 원본 응답(앞400) cityCode=${cityCode} nm="${nm}":`, raw.slice(0, 400));

        let data;
        try {
          data = JSON.parse(raw);
        } catch (parseErr) {
          console.log(`[bus-arrival] JSON 파싱 실패 (XML 응답일 수 있음) cityCode=${cityCode} nm="${nm}":`, parseErr.message, '/ 원본(앞200):', raw.slice(0, 200));
          continue;
        }

        console.log(`[bus-arrival] 파싱된 응답 구조 cityCode=${cityCode} nm="${nm}":`, JSON.stringify(data?.response?.header), '/ body keys:', Object.keys(data?.response?.body || {}));

        // 오류 응답 확인
        const resultCode = data?.response?.header?.resultCode;
        if (resultCode && resultCode !== '00') {
          console.log(`[bus-arrival] TAGO 오류코드 cityCode=${cityCode} nm="${nm}":`, resultCode, data?.response?.header?.resultMsg);
          continue;
        }

        const totalCount = data?.response?.body?.totalCount ?? 0;
        const items = data?.response?.body?.items?.item;

        if (!items || totalCount === 0) {
          console.log(`[bus-arrival] 결과없음 cityCode=${cityCode} nm="${nm}" (totalCount=${totalCount})`);
          continue;
        }

        const list = Array.isArray(items) ? items : [items];
        console.log(`[bus-arrival] cityCode=${cityCode} nm="${nm}" 결과:`, list.length, '건 / 전체 목록:', JSON.stringify(list.map(i => ({ nodeid: i.nodeid, nodenm: i.nodenm }))));

        // 정확 일치 우선, 없으면 첫 번째 항목
        const match = list.find(i => i.nodenm === nm) || list[0];
        if (match?.nodeid) {
          console.log(`[bus-arrival] ✅ nodeId 발견: nodeId=${match.nodeid} nodenm=${match.nodenm} cityCode=${cityCode} (검색어="${nm}")`);
          return { nodeId: match.nodeid, cityCode };
        }
      } catch (e) {
        console.log(`[bus-arrival] 조회 예외 cityCode=${cityCode} nm="${nm}":`, e.message);
      }
    }
  }

  console.log('[bus-arrival] ❌ 모든 조합 실패 — nodeId 없음');
  return null;
}

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
  const { stationName, busNos, arsId, stationId } = q;
  const directId = arsId || stationId || '';

  console.log('[bus-arrival] 요청:', { stationName, busNos, arsId, stationId });

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

  try {
    let list = null;

    // ── STEP 0: ODsay가 넘겨준 arsId/stationId가 있으면 정류장 검색 없이 바로 도착정보 조회
    //           (BusSttnInfoInqireService/getSttnNoList 가 자주 timeout 나서 우회)
    if (directId) {
      console.log(`[bus-arrival] arsId/stationId 직접 사용 시도: nodeId=${directId}`);
      for (const cityCode of CITY_CODES) {
        const result = await fetchArrivalList(directId, cityCode);
        if (result && result.list.length) {
          list = result.list;
          console.log(`[bus-arrival] ✅ arsId/stationId 직접조회 성공 nodeId=${directId} cityCode=${cityCode} 건수=${list.length}`);
          break;
        }
      }
      if (!list) {
        console.log(`[bus-arrival] arsId/stationId(${directId})로 조회 실패 — stationName 검색으로 폴백`);
      }
    }

    // ── STEP 1~2: (직접 조회 실패 시) stationName으로 nodeId 검색 후 도착정보 조회
    if (!list) {
      const found = await findNodeId(stationName);

      if (!found) {
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ arrivals: [], debug: `nodeId not found for: ${stationName}` }),
        };
      }

      const { nodeId, cityCode } = found;
      const result = await fetchArrivalList(nodeId, cityCode);

      if (!result || !result.list.length) {
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ arrivals: [], debug: `no arrivals for nodeId=${nodeId} cityCode=${cityCode}` }),
        };
      }

      list = result.list;
    }

    console.log('[bus-arrival] item[0] 전체 필드:', JSON.stringify(list[0]));

    // 버스 번호 필터 (busNos가 있을 때)
    const busNoArr = busNos ? busNos.split(',').map(s => s.trim()).filter(Boolean) : [];
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
