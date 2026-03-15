/**
 * THE CROSS PASSPORT — Firebase Cloud Functions
 *
 * Trigger 1: submissions 컬렉션 신규 문서 생성
 *   → 모든 관리자(교사)에게 "새 미션 제출" 푸시 알림 발송
 *
 * Trigger 2: submissions 컬렉션 문서 수정 + status → 'approved'
 *   → 해당 학생에게 "미션 승인" 푸시 알림 발송
 *
 * 배포 명령어 (functions/ 디렉토리에서):
 *   npm install
 *   firebase deploy --only functions
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

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
