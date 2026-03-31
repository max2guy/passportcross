/**
 * THE CROSS PASSPORT — Firebase Cloud Functions
 *
 * Trigger 1: submissions 신규 문서 → 관리자에게 "새 미션 제출" 푸시
 * Trigger 2: submissions status → 'approved' → 해당 학생에게 "미션 승인" 푸시
 * Schedule 3: 매일 AM 07:00 KST → 전체 학생에게 "오늘의 미션 도착" 푸시
 * Schedule 4: 매일 PM 07:00 KST → 당일 미션 미제출 학생에게 "완료하셨나요?" 푸시
 *
 * 배포: firebase deploy --only functions
 *
 * [변경사항]
 * - fcmToken(string) → fcmTokens(array) 구조 대응 (하위 호환 유지)
 * - sendEachForMulticast에 try/catch 추가 → 전체 API 실패 시에도 안전 처리
 * - 만료 토큰 자동 삭제: FieldValue.delete() → arrayRemove(token) 로 변경
 * - sendToUsers / sendToAdmins 분리로 도미노 실패 방지
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

/* 고난주간 미션 메타데이터 (날짜 → 테마/구절 매핑) */
const MISSIONS_META = [
  { day: '월', theme: '성전 청결',   verse: '마태복음 21:13' },
  { day: '화', theme: '가장 큰 계명', verse: '마태복음 22:37' },
  { day: '수', theme: '향유 옥합',   verse: '마태복음 26:12' },
  { day: '목', theme: '섬김의 본',   verse: '요한복음 13:15' },
  { day: '금', theme: '다 이루었다', verse: '요한복음 19:30' },
  { day: '토', theme: '부활의 소망', verse: '시편 130:5'    }
];

// 행사 시작일 (KST 기준)
const EVENT_START = new Date('2026-03-30T00:00:00+09:00');

/* 오늘의 미션 인덱스 (0=월 ~ 5=토), 범위 밖이면 -1 */
function getDayIndex() {
  const diffDays = Math.floor((Date.now() - EVENT_START.getTime()) / 86400000);
  return (diffDays >= 0 && diffDays <= 5) ? diffDays : -1;
}

/* 만료 토큰 에러 코드 */
const EXPIRED_CODES = [
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered'
];

/**
 * 문서 데이터에서 FCM 토큰 배열 추출
 * - fcmTokens(array) 우선, 없으면 fcmToken(string) 하위 호환
 */
function extractTokens(docData) {
  const arr = docData.fcmTokens;
  if (Array.isArray(arr) && arr.length) return arr.filter(Boolean);
  const single = docData.fcmToken;
  if (single) return [single];
  return [];
}

/**
 * users 컬렉션에서 모든 FCM 토큰 수집
 * @returns {{ tokens: string[], tokenToUid: Object }}
 */
async function getAllUserTokens() {
  const snap = await db.collection('users').get();
  const tokens = [];
  const tokenToUid = {}; // token → uid (만료 토큰 삭제용)
  snap.forEach(function(doc) {
    extractTokens(doc.data()).forEach(function(t) {
      if (!tokenToUid[t]) { // 중복 제거
        tokenToUid[t] = doc.id;
        tokens.push(t);
      }
    });
  });
  return { tokens, tokenToUid };
}

/**
 * users 컬렉션에서 당일 미션 미제출(0) 또는 반려(3) 학생 토큰만 수집
 */
async function getIncompleteUserTokens(dayIdx) {
  const snap = await db.collection('users').get();
  const tokens = [];
  const tokenToUid = {};
  snap.forEach(function(doc) {
    const d = doc.data();
    const missions = d.missions || [];
    // 0 = 미제출, 3 = 반려(재제출 필요), undefined = 데이터 없음 → 알림 대상
    if (missions[dayIdx] === 0 || missions[dayIdx] === 3 || missions[dayIdx] === undefined) {
      extractTokens(d).forEach(function(t) {
        if (!tokenToUid[t]) {
          tokenToUid[t] = doc.id;
          tokens.push(t);
        }
      });
    }
  });
  return { tokens, tokenToUid };
}

/**
 * 멀티캐스트 발송 + 만료 토큰 자동 삭제 (users 컬렉션)
 * - API 자체 실패 시 try/catch로 안전 처리 (다른 발송에 영향 없음)
 * - 개별 토큰 실패는 responses 배열로 독립 처리
 * - 만료 토큰은 arrayRemove로 삭제 (다른 기기 토큰 보존)
 */
async function sendToUsers(tokens, tokenToUid, title, body) {
  if (!tokens.length) return;

  let res;
  try {
    res = await messaging.sendEachForMulticast({ notification: { title, body }, data: { title, body }, tokens });
  } catch (err) {
    console.error('sendEachForMulticast 전체 실패 (users):', err.message);
    return;
  }

  console.log(`users 발송 성공: ${res.successCount}, 실패: ${res.failureCount}`);

  const deletes = [];
  res.responses.forEach(function(r, i) {
    if (!r.success && r.error && EXPIRED_CODES.includes(r.error.code)) {
      const uid = tokenToUid[tokens[i]];
      const expiredToken = tokens[i];
      if (uid) {
        console.log(`만료 토큰 삭제 (users): uid=${uid}`);
        deletes.push(
          db.collection('users').doc(uid)
            .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(expiredToken) })
            .catch(function() {})
        );
      }
    }
  });
  await Promise.all(deletes);
}

/**
 * 멀티캐스트 발송 + 만료 토큰 자동 삭제 (admins 컬렉션)
 */
async function sendToAdmins(tokens, tokenToEmail, messagePayload) {
  if (!tokens.length) return;

  let res;
  try {
    res = await messaging.sendEachForMulticast(messagePayload);
  } catch (err) {
    console.error('sendEachForMulticast 전체 실패 (admins):', err.message);
    return;
  }

  console.log(`admins 발송 성공: ${res.successCount}, 실패: ${res.failureCount}`);

  const deletes = [];
  res.responses.forEach(function(r, i) {
    if (!r.success && r.error && EXPIRED_CODES.includes(r.error.code)) {
      const email = tokenToEmail[tokens[i]];
      const expiredToken = tokens[i];
      if (email) {
        console.log(`만료 토큰 삭제 (admins): email=${email}`);
        deletes.push(
          db.collection('admins').doc(email)
            .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(expiredToken) })
            .catch(function() {})
        );
      }
    }
  });
  await Promise.all(deletes);
}

/* ─────────────────────────────────────────────
 * Trigger 1: 학생 → 관리자
 * submissions 새 문서 생성 시 모든 교사에게 푸시
 * ───────────────────────────────────────────── */
exports.notifyAdminOnSubmission = functions
  .region('asia-northeast3')
  .firestore
  .document('submissions/{subId}')
  .onCreate(async function(snap) {
    const data = snap.data();
    const studentName = data.userName || '학생';
    const missionName = data.missionName || '미션';

    // admins 컬렉션 전체 조회 → fcmTokens 배열 수집 (fcmToken 단일 필드 하위 호환)
    const adminsSnap = await db.collection('admins').get();
    const tokens = [];
    const tokenToEmail = {};
    adminsSnap.forEach(function(doc) {
      extractTokens(doc.data()).forEach(function(t) {
        if (!tokenToEmail[t]) {
          tokenToEmail[t] = doc.id; // doc.id = 이메일
          tokens.push(t);
        }
      });
    });

    if (!tokens.length) {
      console.log('등록된 관리자 FCM 토큰 없음');
      return null;
    }

    const messagePayload = {
      notification: {
        title: '새 미션 제출 ✝',
        body: `${studentName}님이 [${missionName}]을 제출했습니다. 확인해주세요!`
      },
      data: {
        title: '새 미션 제출 ✝',
        body: `${studentName}님이 [${missionName}]을 제출했습니다. 확인해주세요!`,
        submissionId: snap.id,
        targetUrl: 'admin'
      },
      tokens: tokens
    };

    await sendToAdmins(tokens, tokenToEmail, messagePayload);
    return null;
  });

/* ─────────────────────────────────────────────
 * Trigger 2: 관리자 → 학생
 * submissions 문서 status가 'approved'로 변경될 때 해당 학생에게 푸시
 * - 학생의 모든 기기(fcmTokens 배열)로 전송
 * ───────────────────────────────────────────── */
exports.notifyStudentOnApproval = functions
  .region('asia-northeast3')
  .firestore
  .document('submissions/{subId}')
  .onUpdate(async function(change) {
    const before = change.before.data();
    const after = change.after.data();

    // status 변경이 없거나 'approved'가 아니면 종료
    if (before.status === after.status) return null;
    if (after.status !== 'approved') return null;

    const uid = after.uid;
    if (!uid) return null;

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return null;

    const tokens = extractTokens(userDoc.data());
    if (!tokens.length) {
      console.log(`학생 ${uid}의 FCM 토큰 없음`);
      return null;
    }

    const missionName = after.missionName || '미션';
    const messagePayload = {
      notification: {
        title: '미션 승인! ✝',
        body: `[${missionName}] 승인되었습니다. 여권에서 도장을 확인하세요!`
      },
      data: {
        title: '미션 승인! ✝',
        body: `[${missionName}] 승인되었습니다. 여권에서 도장을 확인하세요!`
      },
      tokens: tokens
    };

    let res;
    try {
      res = await messaging.sendEachForMulticast(messagePayload);
      console.log(`학생 ${uid} 알림 (성공:${res.successCount}, 실패:${res.failureCount})`);
    } catch (err) {
      console.error(`학생 ${uid} 알림 전체 실패:`, err.message);
      return null;
    }

    // 만료 토큰 정리 (arrayRemove로 해당 토큰만 삭제, 다른 기기 토큰 보존)
    const deletes = [];
    res.responses.forEach(function(r, i) {
      if (!r.success && r.error && EXPIRED_CODES.includes(r.error.code)) {
        console.log(`학생 만료 토큰 삭제: uid=${uid}`);
        deletes.push(
          db.collection('users').doc(uid)
            .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(tokens[i]) })
            .catch(function() {})
        );
      }
    });
    await Promise.all(deletes);

    return null;
  });

/* ─────────────────────────────────────────────
 * Schedule 3: AM 07:00 KST — 오늘의 미션 도착 알림 (전체 학생)
 * ───────────────────────────────────────────── */
exports.morningPush = functions
  .region('asia-northeast3')
  .pubsub.schedule('0 7 * * *')
  .timeZone('Asia/Seoul')
  .onRun(async function() {
    const dayIdx = getDayIndex();
    if (dayIdx < 0) { console.log('행사 기간 아님'); return null; }
    const m = MISSIONS_META[dayIdx];
    const { tokens, tokenToUid } = await getAllUserTokens();
    await sendToUsers(
      tokens, tokenToUid,
      '☀️ 오늘의 미션이 도착했습니다',
      m.day + '요일 · ' + m.theme + ' — ' + m.verse + ' 오늘의 미션을 확인하세요 →'
    );
    return null;
  });

/* ─────────────────────────────────────────────
 * Schedule 4: PM 07:00 KST — 미션 완료 독려 알림 (미제출 학생만)
 * ───────────────────────────────────────────── */
exports.eveningPush = functions
  .region('asia-northeast3')
  .pubsub.schedule('0 19 * * *')
  .timeZone('Asia/Seoul')
  .onRun(async function() {
    const dayIdx = getDayIndex();
    if (dayIdx < 0) { console.log('행사 기간 아님'); return null; }
    const { tokens, tokenToUid } = await getIncompleteUserTokens(dayIdx);
    await sendToUsers(
      tokens, tokenToUid,
      '🌙 오늘 미션, 완료하셨나요?',
      '아직 인증을 올리지 않으셨습니다. 실천한 내용을 기록해 주세요.'
    );
    return null;
  });

/* ─────────────────────────────────────────────
 * Trigger 5: 강제 업데이트 브로드캐스트
 * broadcasts 컬렉션 새 문서 생성 시 → 전체 학생 + 관리자에게 FCM 푸시
 * 클라이언트(onSnapshot)가 requiredVersion 감지해 forceRefresh() 호출하는 것과 병행:
 * FCM은 앱이 꺼진 기기까지 커버
 * ───────────────────────────────────────────── */
exports.onBroadcastUpdate = functions
  .region('asia-northeast3')
  .firestore
  .document('broadcasts/{broadcastId}')
  .onCreate(async function(snap) {
    const data = snap.data();
    if (data.type !== 'forceUpdate') return null;

    const version = data.requiredVersion || '';
    const title = '⚡ 앱 업데이트 알림';
    const body = version
      ? `새 버전(v${version})이 배포되었습니다. 앱을 열면 자동으로 업데이트됩니다.`
      : '새 버전이 배포되었습니다. 앱을 열면 자동으로 업데이트됩니다.';

    // 학생 + 관리자 토큰 전부 수집
    const [userResult, adminsSnap] = await Promise.all([
      getAllUserTokens(),
      db.collection('admins').get()
    ]);

    const allTokens = [...userResult.tokens];
    const tokenToCollection = {}; // token → { col, id } (만료 정리용)

    userResult.tokens.forEach(function(t) {
      tokenToCollection[t] = { col: 'users', id: userResult.tokenToUid[t] };
    });
    adminsSnap.forEach(function(doc) {
      extractTokens(doc.data()).forEach(function(t) {
        if (!tokenToCollection[t]) {
          tokenToCollection[t] = { col: 'admins', id: doc.id };
          allTokens.push(t);
        }
      });
    });

    if (!allTokens.length) {
      console.log('브로드캐스트: 등록된 토큰 없음');
      return null;
    }

    let res;
    try {
      res = await messaging.sendEachForMulticast({ notification: { title, body }, data: { title, body }, tokens: allTokens });
    } catch (err) {
      console.error('브로드캐스트 전체 실패:', err.message);
      return null;
    }

    console.log(`브로드캐스트 발송 성공:${res.successCount}, 실패:${res.failureCount}`);

    // 만료 토큰 정리
    const deletes = [];
    res.responses.forEach(function(r, i) {
      if (!r.success && r.error && EXPIRED_CODES.includes(r.error.code)) {
        const info = tokenToCollection[allTokens[i]];
        if (info) {
          deletes.push(
            db.collection(info.col).doc(info.id)
              .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(allTokens[i]) })
              .catch(function() {})
          );
        }
      }
    });
    await Promise.all(deletes);

    return null;
  });
