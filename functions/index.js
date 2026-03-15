/**
 * THE CROSS PASSPORT — Firebase Cloud Functions
 *
 * Trigger 1: submissions 신규 문서 → 관리자에게 "새 미션 제출" 푸시
 * Trigger 2: submissions status → 'approved' → 해당 학생에게 "미션 승인" 푸시
 * Schedule 3: 매일 AM 07:00 KST → 전체 학생에게 "오늘의 미션 도착" 푸시
 * Schedule 4: 매일 PM 07:00 KST → 당일 미션 미제출 학생에게 "완료하셨나요?" 푸시
 *
 * 배포: firebase deploy --only functions
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

/* users 컬렉션에서 FCM 토큰 전체 수집 */
async function getAllUserTokens() {
  const snap = await db.collection('users').get();
  const tokens = [], uidByIdx = {};
  snap.forEach(function(doc) {
    const t = doc.data().fcmToken;
    if (t) { uidByIdx[tokens.length] = doc.id; tokens.push(t); }
  });
  return { tokens, uidByIdx };
}

/* users 컬렉션에서 당일 미션 미제출(0) 학생 토큰만 수집 */
async function getIncompleteUserTokens(dayIdx) {
  const snap = await db.collection('users').get();
  const tokens = [], uidByIdx = {};
  snap.forEach(function(doc) {
    const d = doc.data();
    const t = d.fcmToken;
    const missions = d.missions || [];
    // 0 = 미제출, 3 = 반려(재제출 필요) → 알림 대상
    if (t && (missions[dayIdx] === 0 || missions[dayIdx] === 3 || missions[dayIdx] === undefined)) {
      uidByIdx[tokens.length] = doc.id; tokens.push(t);
    }
  });
  return { tokens, uidByIdx };
}

/* 멀티캐스트 발송 + 만료 토큰 정리 (users 컬렉션) */
async function sendToUsers(tokens, uidByIdx, title, body) {
  if (!tokens.length) return;
  const res = await messaging.sendEachForMulticast({ data: { title, body }, tokens });
  console.log(`발송 성공: ${res.successCount}, 실패: ${res.failureCount}`);
  const EXPIRED = ['messaging/invalid-registration-token','messaging/registration-token-not-registered'];
  const deletes = [];
  res.responses.forEach(function(r, i) {
    if (!r.success && r.error && EXPIRED.includes(r.error.code) && uidByIdx[i]) {
      deletes.push(db.collection('users').doc(uidByIdx[i])
        .update({ fcmToken: admin.firestore.FieldValue.delete() }).catch(function(){}));
    }
  });
  await Promise.all(deletes);
}

/* ─────────────────────────────────────────────
 * 유틸: 만료된 FCM 토큰을 Firestore에서 삭제
 * tokens: 발송한 토큰 배열
 * responses: sendEachForMulticast 응답 배열
 * collectionName: 'admins' | 'users'
 * docIdFn: (index) => 해당 토큰을 가진 문서 ID를 반환하는 함수
 * ───────────────────────────────────────────── */
async function cleanupExpiredTokens(tokens, responses, collectionName, docIdFn) {
  const EXPIRED_CODES = [
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered'
  ];
  const deletePromises = [];
  responses.forEach(function(res, idx) {
    if (!res.success && res.error && EXPIRED_CODES.includes(res.error.code)) {
      const docId = docIdFn(idx);
      if (docId) {
        deletePromises.push(
          db.collection(collectionName).doc(docId)
            .update({ fcmToken: admin.firestore.FieldValue.delete() })
            .catch(function() {}) // 실패해도 무시
        );
      }
    }
  });
  await Promise.all(deletePromises);
}

/* ─────────────────────────────────────────────
 * Trigger 1: 학생 → 관리자
 * submissions 새 문서 생성 시 모든 교사에게 푸시
 * ───────────────────────────────────────────── */
exports.notifyAdminOnSubmission = functions
  .region('asia-northeast3') // 서울 리전 (선택 사항)
  .firestore
  .document('submissions/{subId}')
  .onCreate(async function(snap) {
    const data = snap.data();
    const studentName = data.userName || '학생';
    const missionName = data.missionName || '미션';

    // admins 컬렉션 전체 조회 → fcmToken 수집
    const adminsSnap = await db.collection('admins').get();

    const tokens = [];
    const emailByIndex = {}; // 만료 토큰 삭제용: 인덱스 → 이메일 매핑
    adminsSnap.forEach(function(doc) {
      const token = doc.data().fcmToken;
      if (token) {
        emailByIndex[tokens.length] = doc.id; // doc.id = 이메일
        tokens.push(token);
      }
    });

    if (tokens.length === 0) {
      console.log('등록된 FCM 토큰이 없습니다.');
      return null;
    }

    const message = {
      data: {
        title: '새 미션 제출 ✝',
        body: `${studentName}님이 [${missionName}]을 제출했습니다. 확인해주세요!`
      },
      tokens: tokens
    };

    const response = await messaging.sendEachForMulticast(message);
    console.log(`발송 성공: ${response.successCount}, 실패: ${response.failureCount}`);

    // 만료 토큰 정리
    await cleanupExpiredTokens(
      tokens,
      response.responses,
      'admins',
      function(idx) { return emailByIndex[idx]; }
    );

    return null;
  });

/* ─────────────────────────────────────────────
 * Trigger 2: 관리자 → 학생
 * submissions 문서 status가 'approved'로 변경될 때 해당 학생에게 푸시
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

    // 학생 문서에서 FCM 토큰 조회
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return null;

    const fcmToken = userDoc.data().fcmToken;
    if (!fcmToken) {
      console.log(`학생 ${uid}의 FCM 토큰 없음`);
      return null;
    }

    const missionName = after.missionName || '미션';

    const message = {
      token: fcmToken,
      data: {
        title: '미션 승인! ✝',
        body: `[${missionName}] 승인되었습니다. 여권에서 도장을 확인하세요!`
      }
    };

    try {
      await messaging.send(message);
      console.log(`학생 ${uid} 알림 발송 완료`);
    } catch (err) {
      // 만료 토큰이면 Firestore에서 삭제
      const EXPIRED_CODES = [
        'messaging/invalid-registration-token',
        'messaging/registration-token-not-registered'
      ];
      if (EXPIRED_CODES.includes(err.errorInfo && err.errorInfo.code)) {
        await db.collection('users').doc(uid)
          .update({ fcmToken: admin.firestore.FieldValue.delete() })
          .catch(function() {});
      }
      console.error('학생 알림 발송 실패:', err.message);
    }

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
    const { tokens, uidByIdx } = await getAllUserTokens();
    await sendToUsers(
      tokens, uidByIdx,
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
    const { tokens, uidByIdx } = await getIncompleteUserTokens(dayIdx);
    await sendToUsers(
      tokens, uidByIdx,
      '🌙 오늘 미션, 완료하셨나요?',
      '아직 인증을 올리지 않으셨습니다. 실천한 내용을 기록해 주세요.'
    );
    return null;
  });
