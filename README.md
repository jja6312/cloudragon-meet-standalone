# Cloudragon Meet · 독립 설치판

카카오 계정이나 Cloudragon 서버 없이 자신의 PC·서버에서 사용하는 회의 녹음 웹앱이다. 설치할 때 아이디·비밀번호와 필요한 API 키를 지정한다. 데이터는 해당 설치의 SQLite에 보관한다.

## 바로 실행

Node.js **22.13.1 이상**(24 LTS 권장)과 Git을 설치한 뒤 터미널에서 실행한다. Windows PowerShell, macOS, Linux에서 같은 명령을 사용한다.

```sh
git clone https://github.com/jja6312/cloudragon-meet-standalone.git
cd cloudragon-meet-standalone
npm ci
npm run setup
npm run build
npm start
```

브라우저에서 **http://localhost:8088**에 접속해 설치 시 입력한 계정으로 로그인한다. 비밀번호는 12자 이상으로 지정한다. 초기 비밀번호·기본 API 키는 없다. `npm run setup`이 빠지면 서버는 실행을 거부한다.

설정 질문에서:

- **Soniox 키를 생략**하면 마이크·공유 오디오 녹음, 저장·재생, 수동 회의록을 사용할 수 있다.
- **Soniox 키를 입력**하면 실시간 전사·번역, 선택한 번역의 음성 재생을 사용할 수 있다.
- **AI 제공자를 `oci` 또는 `openai`**로 지정하면 전사가 있는 녹음의 종료 후 회의록·한 장 요약을 자동 생성한다. 전사 교정은 기록 화면에서 별도 실행한다. API 비용은 본인의 제공자 계정에 청구된다.

설정을 변경할 때는 서버를 종료하고 다음 명령을 실행한 뒤 재시작한다. 기존 키는 화면에 표시하지 않으며 Enter로 유지한다. 제공자를 바꾸는 경우 새 제공자에 맞는 키·모델을 입력한다. 설정을 저장하면 기존 로그인 세션은 만료된다.

```sh
npm run setup -- --update
npm start
```

## 사용 흐름

1. **새 녹음 · 번역**에서 제목, 마이크 또는 공유 오디오, 언어를 선택하고 녹음을 시작한다.
2. **종료 · 저장**하면 마지막 전사와 원음 조각을 서버에 반영한 뒤 완료한다. 실패하면 기기 임시본을 유지하고 **저장 다시 시도**를 제공한다. 페이지를 다시 열면 **기기에 남은 기록 → 저장 복구**에서 이어간다.
3. **저장하지 않고 종료**하면 음성과 전사를 모두 삭제한다. 연결 실패 시 **삭제 다시 시도**로 이어간다. 서버로 먼저 전송된 임시 데이터도 삭제 요청 대상이다.
4. **나의 기록**에서 원음 재생, 원문·AI 교정본, 편집 가능한 회의록, 인쇄·PDF 저장 가능한 한 장 요약을 확인한다. AI 교정은 원문을 덮어쓰지 않는다.
5. **회의 배경 · 고객 · 프로젝트 맥락**에 참고 정보를 저장한 뒤 **AI 회의록 생성**을 누르면 그 맥락을 함께 사용한다. Work 자동 연동은 없다.

녹음 시간은 최대 9시간이다. 브라우저 저장 공간·서버 여유 공간·네트워크에 따라 실제 가능한 시간은 달라진다. **이 저장소는 브라우저용이며 Android 네이티브 앱은 포함하지 않는다. 휴대폰 잠금 상태의 녹음·전사 지속을 보장하지 않는다.**

`d` 키로 다크·라이트 모드를 바꾼다. 입력 중에는 단축키가 동작하지 않는다. 한국어 양방향 번역은 상대 언어를 선택하고 **내 한국어도 상대 언어로 번역**을 켠다. 음성은 해당 번역의 **▶ 번역 재생**을 누른 경우에만 출력된다. PC 공유 소리는 브라우저 공유창에서 **탭 오디오 공유**를 함께 선택한다.

## API 키 준비

키는 받는 사람이 직접 발급하고 설치 서버의 설정에만 입력한다. 이 저장소에는 기존 Cloudragon 키·계정·회의 데이터·배포 접근권한이 없다.

### Soniox

[Soniox Console](https://console.soniox.com/)에서 프로젝트의 API 키를 만든다. 프로젝트 리전(`us`·`eu`·`jp`)과 설치 설정을 맞춘다. 실시간 전사와 임시 키 발급 권한이 필요하며, 음성 출력에는 실시간 TTS 권한도 필요하다. [권한 안내](https://soniox.com/docs/guides/api-key-permissions).

장기 키는 서버에 남고, 브라우저는 60초 이내에 연결하는 일회용 전사 키를 받는다. 연결 한도는 2시간이며 만료·끊김 시 재연결한다. 재연결 전의 누락 구간을 자동 소급 전사하지 않는다. [임시 키 동작](https://soniox.com/docs/guides/temporary-api-keys).

### OCI Generative AI

1. OCI Console의 **Analytics & AI → Generative AI**에서 사용할 리전과 컴파트먼트를 선택한다.
2. Generative AI 프로젝트를 만들거나 선택하고 프로젝트 OCID를 확인한다.
3. **Generative AI 전용 API key**를 만들고 해당 프로젝트에서 사용할 권한을 부여한다. 일반 OCI IAM 서명용 `.pem` 키·지문은 이 설정의 키가 아니다.
4. 설치 설정의 `AI_PROVIDER=oci`, `AI_API_KEY`, `OCI_GENAI_PROJECT`, `OCI_GENAI_REGION`, `AI_MODEL`을 지정한다. 초기 모델 제안은 기존 Meet과 같은 `xai.grok-4.6`이며, 실제 계정·리전에서 사용 가능한 모델 ID를 확인해야 한다.

지원하도록 구성한 리전은 `us-chicago-1`, `us-ashburn-1`, `us-phoenix-1`이다. 프로젝트와 키의 리전을 맞춘다. 모델의 실제 사용 가능 여부와 API 권한은 첫 요청에서 확인된다. OCI가 경유하는 외부 모델은 OCI 리전 밖에서 처리될 수 있다. 이 버전은 설정형 API-key 인증만 구현하며, OCI 생산 환경의 IAM/instance principal 인증은 별도 확장 대상이다.

[Oracle API 키 생성](https://docs.oracle.com/en-us/iaas/Content/generative-ai/create-api-key.htm) · [OCI Responses API와 프로젝트·인증](https://docs.oracle.com/en-us/iaas/Content/generative-ai/responses-api.htm).

### OpenAI

OpenAI API 프로젝트에서 발급한 키를 `AI_API_KEY`로, 사용할 수 있는 모델 ID를 `AI_MODEL`로 지정하고 `AI_PROVIDER=openai`를 선택한다. ChatGPT 구독과 API 결제는 별개이며 이 앱은 API 키를 사용한다. 서버는 [Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)를 `store:false`로 호출한다. 모델의 사용 가능 여부·출력 한도는 제공자 계정에서 확인한다.

## 다른 기기·외부 서버에서 사용

마이크는 localhost 또는 HTTPS에서 사용할 수 있다. 휴대폰에서 PC의 HTTP IP 주소로 접속하는 구성은 지원하지 않는다. 자신의 HTTPS 도메인을 준비한 뒤 `.env`의 `BASE_URL`을 정확한 주소로 바꾸고 서버를 재시작한다. 외부 도메인의 하위 경로 대신 도메인 루트(`/`)에서 제공한다.

앱 기본 포트는 로컬 `127.0.0.1:8088`이다. 기존 HTTPS 리버스 프록시에서 다음처럼 연결한다. 프록시는 원래 Host를 보존해야 한다. 이 저장소는 DNS·TLS·시스템 서비스를 자동 변경하지 않는다.

```nginx
location / {
    proxy_pass http://127.0.0.1:8088;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 3m;
    proxy_read_timeout 100s;
}
```

Docker를 사용하는 별도 서버라면 설정·소스 빌드 후 다음 명령으로 실행할 수 있다. 로컬 Node 설치 없이 초기 설정만 수행하려면 Node 24 컨테이너에서 `node scripts/setup.mjs`를 실행해도 된다. Docker 실제 빌드·운영 기동은 개발 호스트 제약으로 검증하지 않았다.

```sh
docker compose up -d --build
```

Compose는 포트를 loopback에만 공개하며 데이터는 `meet-data` 볼륨에 보존한다. `.env`는 이미지 빌드 컨텍스트에 포함하지 않는다. 파일 권한은 POSIX에서 600이며 Windows에서는 설치 폴더의 접근 권한을 운영체제에서 제한한다.

## 보관·복구·업데이트

- 일반 실행의 데이터: `data/meet.sqlite`와 같은 폴더의 WAL 파일. 비밀 설정: `.env`. 두 위치 모두 Git에서 제외한다. 비밀번호는 scrypt 해시로 저장한다. 서버 데이터 자체는 평문 SQLite이므로 디스크 암호화와 접근 권한은 설치 운영자가 관리한다.
- 백업은 **앱을 정상 종료한 뒤** `.env`와 `data` 폴더 전체를 안전한 별도 위치에 복사한다. Docker는 앱을 정지한 뒤 해당 볼륨을 백업한다. 실행 중 DB 파일 하나만 복사하지 않는다.
- 복구는 앱을 멈추고 백업 데이터 폴더와 해당 `.env`를 복원한 뒤 시작한다. 다른 설치 데이터와 합치거나 기존 서버 DB로 연결하지 않는다.
- 업데이트: 백업 후 `git pull --ff-only`, `npm ci`, `npm run build`, `npm start`. 이 초기 버전은 자체 SQLite 테이블만 생성하며 Cloudragon ADB/Flyway 마이그레이션은 사용하지 않는다.
- 삭제는 앱 DB와 기기 임시본의 논리적 삭제다. 과거 백업·SQLite WAL·디스크의 포렌식 삭제를 보장하지 않는다. 삭제한 기록을 포함한 백업의 보존 여부는 운영자가 관리한다.

한 설치당 **운영자 계정 1개·개인 공간 1개**를 지원한다. 카카오·통합 SSO·초대·팀별 권한·정기결제·Work 자동 전달·Cloudragon 공통 네비게이션·기존 APK는 분리 범위에서 제외했다. 여러 사람의 계정별 데이터 격리가 필요하면 별도 설치를 사용하거나 사용자/권한 모델을 확장해야 한다.

## 개발·검증

```sh
npm test
npm run build
npm run check:secrets
npx playwright install chromium
npm run test:browser
```

로컬 UI 개발은 `.env`의 `BASE_URL=http://127.0.0.1:5173`로 지정한 뒤 터미널 두 개에서 `npm run dev:server`, `npm run dev`를 실행한다. 설정을 운영 실행에 사용할 때는 `BASE_URL`을 원래 주소로 돌린다. 개발 서버는 외부에 공개하지 않는다.

구조: `src`의 녹음·전사 엔진과 UI → 동일 출처 `server`의 자체 로그인·SQLite·고정 제공자 API. `scripts/setup.mjs`는 설정 생성, `tests`는 합성 자료로 API와 실제 Chromium 흐름을 검증한다. **실제 유료 AI·Soniox 계정, Galaxy 잠금·9시간 연속 녹음, Docker 운영 설치는 별도 실환경 검증이 필요하다.**

[분리 근거·코드 출처](docs/PROVENANCE.md) · [검증 기록](docs/VALIDATION.md) · [보안·운영 경계](SECURITY.md).
