# 코드 출처와 분리 범위

추출 기준: `jja6312/cloudragon-platform`의 main **bd3f1e56de221d7218d0f076a3e2c015d9940b87** (2026-10-30 확인).

기존 `apps/meet-web/src/{capture,drafts,limits,model,playback,recording,speech}.ts`와 PCM worklet을 재사용했다. import를 자체 API 클라이언트로 바꾸고 Work 참조·자동 전달 문구를 제거했으며, 기기 임시 저장소 이름을 독립판으로 구분했다. 종료 직전 전사 수신·업로드 경합·9시간 한도·저장 취소·복구 동작을 포함한다.

독립판의 UI, Node 서버, SQLite 스키마, 자체 계정, 설정 도구, 배포 예시, 테스트는 이 저장소에서 구성했다. Spring/ADB/OCI Object Storage/카카오/중앙 SSO/팀 이용권 의존성은 없다. 음성과 메타데이터는 이 설치의 SQLite에 저장한다.

Meet 아이콘은 기존 Cloudragon Meet 자산이다. Pretendard 폰트는 동봉한 `public/Pretendard-LICENSE.txt`를 따른다. 이 저장소의 전달은 소스 공유를 위한 것이며, 별도의 오픈소스 라이선스·상표 사용권을 자동 부여하지 않는다. 공개 배포·재라이선스 범위는 소유자와 별도로 정한다.

기존 Git 이력, 운영 배포 설정, 서명키, 원본 APK, 고객 자료, 타 서비스 소스는 이전하지 않았다. 따라서 Cloudragon 운영 사이트나 기존 Android 앱을 이 코드로 업데이트하지 않는다. 개발 중인 미서명 Android 후속 브랜치도 포함하지 않는다.
