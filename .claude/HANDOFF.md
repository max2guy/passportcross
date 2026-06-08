# passportcross (THE CROSS PASSPORT) — Codex Handoff (v3.1.2)

## 현재 상태
- 브랜치: `main`
- 최신 커밋: `9791427 fix: SW CDN cache - clone() before return to avoid consumed body`
- 배포: GitHub Pages (https://max2guy.github.io/passportcross/)

## 방금 수정한 내용

### 문제 (3단계 디버깅으로 발견)

**1단계**: `<script src>` 태그의 no-cors 요청 → opaque response(status 0) → `status===200` 체크 실패 → CacheStorage 저장 불가
**2단계**: CORS mode fetch로 수정했으나, `res.clone()`을 `caches.open().then()` 내부(비동기)에서 호출 → `return res` 이후 body가 소비된 뒤 clone 시도 → 저장 실패
**3단계**: `const resClone = res.clone()`을 return 이전 동기적으로 호출 → 정상 저장

### 해결 방법
**sw.js** (v165 → v168, 3번의 수정):
- `www.gstatic.com` (Firebase SDK) cache-first 인터셉터
- CORS mode fetch: `fetch(new Request(e.request, {mode: 'cors', credentials: 'omit'}))`
- `const resClone = res.clone()` → return 전 동기 호출로 body 소비 전 clone 확보
- CACHE_NAME: `passport-cross-v165` → `passport-cross-v168`

### 수정하지 않은 것
- `index.html` 1482-1485행 Firebase `<script>` defer 추가 불가 — 1487행 inline script가 `firebase.initializeApp()` top-level 호출하므로 defer 적용 시 앱 깨짐

## 프로젝트 개요
- 선교 여권 PWA (THE CROSS PASSPORT)
- Firebase 10.12.0 (Auth, Firestore, FCM), 순수 HTML+JS
- GitHub Pages 배포, 관리자 패널(admin.html) 포함
- FCM 푸시 알림, 사진 제출 인증, 관리자 알림 딥링크

## 주요 파일
- `index.html` — 앱 진입점 (3739행, Firebase 스크립트 1482-1485행)
- `admin.html` — 관리자 패널
- `sw.js` — Service Worker (v168, gstatic CDN cache-first)
- `manifest.json` — PWA 메타데이터

## 다음으로 할 수 있는 작업
- index.html 1487행 inline script를 DOMContentLoaded로 래핑하여 Firebase defer 적용
- CDN 스크립트 로컬 호스팅으로 완전한 CDN 독립
- Chrome Task Manager로 실제 PWA 앱 CPU 사용 확인

## 빌드 & 배포
```bash
# 배포 (GitHub Pages)
git add .
git commit -m "..."
git push
```
