![Litefuse GitHub Banner](https://litefuse.ai/images/docs/github-readme/github-banner.png)

<div align="center">
   <div>
      <h3>
      <a href="https://litefuse.ai/kr">
            <strong>🇰🇷 🤝 🪢</strong>
         </a> · 
         <a href="https://cloud.litefuse.ai">
            <strong>Litefuse Cloud</strong>
         </a> · 
         <a href="https://litefuse.ai/self-hosting">
            <strong>셀프 호스트</strong>
         </a> · 
         <a href="https://litefuse.ai/demo">
            <strong>데모</strong>
         </a>
      </h3>
   </div>

   <div>
      <a href="https://litefuse.ai/docs"><strong>문서</strong></a> ·
      <a href="https://litefuse.ai/issues"><strong>버그 신고</strong></a> ·
      <a href="https://litefuse.ai/ideas"><strong>기능 요청</strong></a> ·
      <a href="https://litefuse.ai/changelog"><strong>변경 내역</strong></a> ·
      <a href="https://litefuse.ai/roadmap"><strong>로드맵</strong></a> ·
   </div>
   <br/>
   <span>Litefuse는 지원 및 기능 요청을 위해 <a href="https://github.com/orgs/Litefuse/discussions"><strong>GitHub Discussions</strong></a>를 사용합니다.</span>
   <br/>
   <span><b>채용 중입니다.</b> <a href="https://litefuse.ai/careers"><strong>함께 하세요</strong></a> – 제품 엔지니어링 및 기술 go-to-market 역할의 인재를 찾고 있습니다.</span>
   <br/>
   <br/>
   <div>
   </div>
</div>

<p align="center">
   <a href="https://github.com/selectdb/Litefuse-doris/blob/main/LICENSE">
   <img src="https://img.shields.io/badge/License-MIT-E11311.svg" alt="MIT License">
   </a>
   <a href="https://www.ycombinator.com/companies/Litefuse"><img src="https://img.shields.io/badge/Y%20Combinator-W23-orange" alt="Y Combinator W23"></a>
   <a href="https://hub.docker.com/u/Litefuse" target="_blank">
   <img alt="Docker Pulls" src="https://img.shields.io/docker/pulls/Litefuse/Litefuse?labelColor=%20%23FDB062&logo=Docker&labelColor=%20%23528bff"></a>
   <a href="https://pypi.python.org/pypi/Litefuse"><img src="https://img.shields.io/pypi/dm/Litefuse?logo=python&logoColor=white&label=pypi%20Litefuse&color=blue" alt="Litefuse Python package on PyPi"></a>
   <a href="https://www.npmjs.com/package/Litefuse"><img src="https://img.shields.io/npm/dm/Litefuse?logo=npm&logoColor=white&label=npm%20Litefuse&color=blue" alt="Litefuse npm package"></a>
   <br/>
   <a href="https://discord.com/invite/7NXusRtqYU" target="_blank">
   <img src="https://img.shields.io/discord/1111061815649124414?logo=discord&labelColor=%20%235462eb&logoColor=%20%23f5f5f5&color=%20%235462eb"
      alt="chat on Discord"></a>
   <a href="https://twitter.com/intent/follow?screen_name=Litefuse" target="_blank">
   <img src="https://img.shields.io/twitter/follow/Litefuse?logo=X&color=%20%23f5f5f5"
      alt="follow on X(Twitter)"></a>
   <a href="https://www.linkedin.com/company/Litefuse/" target="_blank">
   <img src="https://custom-icon-badges.demolab.com/badge/LinkedIn-0A66C2?logo=linkedin-white&logoColor=fff"
      alt="follow on LinkedIn"></a>
   <a href="https://github.com/selectdb/Litefuse-doris/graphs/commit-activity" target="_blank">
   <img alt="Commits last month" src="https://img.shields.io/github/commit-activity/m/Litefuse/Litefuse?labelColor=%20%2332b583&color=%20%2312b76a"></a>
   <a href="https://github.com/selectdb/Litefuse-doris/" target="_blank">
   <img alt="Issues closed" src="https://img.shields.io/github/issues-search?query=repo%3ALitefuse%2FLitefuse%20is%3Aclosed&label=issues%20closed&labelColor=%20%237d89b0&color=%20%235d6b98"></a>
   <a href="https://github.com/selectdb/Litefuse-doris/discussions/" target="_blank">
   <img alt="Discussion posts" src="https://img.shields.io/github/discussions/Litefuse/Litefuse?labelColor=%20%239b8afb&color=%20%237a5af8"></a>
</p>

<p align="center">
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.cn.md"><img alt="简体中文版自述文件" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./README.ja.md"><img alt="日本語のREADME" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="./README.kr.md"><img alt="README in Korean" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
</p>

Litefuse는 **오픈 소스 LLM 엔지니어링** 플랫폼입니다.  
팀이 협업하여 AI 애플리케이션을 **개발, 모니터링, 평가** 및 **디버그**할 수 있도록 도와줍니다.  
Litefuse는 몇 분 안에 셀프 호스팅할 수 있으며, 검증된(battle-tested) 솔루션입니다.

[![Litefuse Overview Video](https://github.com/user-attachments/assets/3926b288-ff61-4b95-8aa1-45d041c70866)](https://litefuse.ai/watch-demo)

## ✨ 주요 기능

![Litefuse Overview](https://litefuse.ai/images/docs/github-readme/github-feature-overview.png)

- **LLM 애플리케이션 관측**  
  앱에 계측(instrumentation)을 추가하여 Litefuse로 trace 데이터를 수집함으로써, 검색, 임베딩, 또는 에이전트 동작과 같은 LLM 호출 및 기타 관련 로직을 추적할 수 있습니다. 복잡한 로그와 사용자 세션을 확인 및 디버깅 해보세요. 인터랙티브 데모를 통해 실제 작동 예를 확인할 수 있습니다.

- **프롬프트 관리**  
  프롬프트를 중앙에서 관리하고 버전 관리하며 협업으로 수정할 수 있도록 도와줍니다. 서버와 클라이언트 측의 강력한 캐싱 덕분에 애플리케이션에 지연(latency)을 추가하지 않고도 프롬프트를 반복 개선할 수 있습니다.

- **평가**  
  LLM 애플리케이션 개발 워크플로우에서 핵심적인 역할을 하며, Litefuse는 여러분의 필요에 맞게 유연하게 대응합니다. LLM을 심사자로 활용하는 기능, 사용자 피드백 수집, 수동 라벨링 및 API/SDK를 통한 맞춤 평가 파이프라인을 지원합니다.

- **데이터셋**  
  LLM 애플리케이션 평가를 위한 테스트 세트와 벤치마크를 제공하여, 지속적인 개선, 배포 전 테스트, 구조화된 실험, 유연한 평가 및 LangChain과 LlamaIndex와 같은 프레임워크와의 원활한 통합을 지원합니다.

- **LLM 플레이그라운드**  
  프롬프트와 모델 구성에 대해 테스트 및 반복 개선할 수 있는 도구로, 피드백 루프를 단축하여 개발 속도를 높여줍니다. trace에서 이상한 결과가 발생하면 플레이그라운드로 바로 이동해 개선할 수 있습니다.

- **종합 API**  
  Litefuse는 API를 통해 제공되는 구성 요소들을 활용하여 맞춤형 LLMOps 워크플로우를 강화하는 데 자주 사용됩니다. OpenAPI 명세, Postman 컬렉션, Python 및 JS/TS용 타입드 SDK가 제공됩니다.

## 📦 Litefuse 배포

![Litefuse Deployment Options](https://litefuse.ai/images/docs/github-readme/github-deployment-options.png)

### Litefuse Cloud

Litefuse 팀이 관리하는 배포 방식으로, 후한 무료 플랜(취미 플랜)을 제공하며 신용카드가 필요하지 않습니다.

<div align="center">
    <a href="https://cloud.litefuse.ai" target="_blank">
        <img alt="Static Badge" src="https://img.shields.io/badge/»%20Sign%20up%20for%20Litefuse%20Cloud-8A2BE2?&color=orange">
    </a>
</div>

### Litefuse 셀프 호스트

자체 인프라에서 Litefuse를 실행하세요:

- [로컬 (docker compose)](https://litefuse.ai/self-hosting/local): Docker Compose를 사용하여 본인의 컴퓨터에서 5분 안에 Litefuse를 실행할 수 있습니다.

  ```bash
  # 최신 Litefuse 저장소 클론
  git clone https://github.com/selectdb/Litefuse-doris.git
  cd Litefuse

  # Litefuse docker compose 실행
  docker compose up
  ```

- [Kubernetes (Helm)](https://litefuse.ai/self-hosting/kubernetes-helm): Helm을 사용해 Kubernetes 클러스터에서 Litefuse를 실행합니다. 이는 권장되는 프로덕션 배포 방식입니다.
- [VM](https://litefuse.ai/self-hosting/docker-compose): Docker Compose를 사용해 단일 가상 머신에서 Litefuse를 실행합니다.
- Terraform 템플릿: [AWS](https://litefuse.ai/self-hosting/aws), [Azure](https://litefuse.ai/self-hosting/azure), [GCP](https://litefuse.ai/self-hosting/gcp)

자세한 내용은 [자체 호스팅 문서](https://litefuse.ai/self-hosting)를 참조하세요.

## 🔌 통합 기능

![Litefuse Integrations](https://litefuse.ai/images/docs/github-readme/github-integrations.png)

### 주요 통합:

| 통합                                                                        | 지원                       | 설명                                                                                                                                                               |
| --------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [SDK](https://litefuse.ai/docs/sdk)                                         | Python, JS/TS              | SDK를 사용하여 완전한 유연성을 갖춘 수동 계측(manual instrumentation)을 수행합니다.                                                                                |
| [OpenAI](https://litefuse.ai/integrations/model-providers/openai-py)        | Python, JS/TS              | OpenAI SDK의 드롭인 대체(drop-in replacement)를 통해 자동 계측(automated instrumentation)을 수행합니다.                                                            |
| [Langchain](https://litefuse.ai/docs/integrations/langchain)                | Python, JS/TS              | Langchain 애플리케이션에 callback 핸들러를 전달하여 자동 계측합니다.                                                                                               |
| [LlamaIndex](https://litefuse.ai/docs/integrations/llama-index/get-started) | Python                     | LlamaIndex 콜백 시스템을 통한 자동 계측을 지원합니다.                                                                                                              |
| [Haystack](https://litefuse.ai/docs/integrations/haystack)                  | Python                     | Haystack 콘텐츠 추적 시스템을 통한 자동 계측을 지원합니다.                                                                                                         |
| [LiteLLM](https://litefuse.ai/docs/integrations/litellm)                    | Python, JS/TS (proxy only) | GPT의 드롭인 대체품으로 어떤 LLM도 사용할 수 있습니다. Azure, OpenAI, Cohere, Anthropic, Ollama, VLLM, Sagemaker, HuggingFace, Replicate 등 100개 이상의 LLM 지원. |
| [Vercel AI SDK](https://litefuse.ai/docs/integrations/vercel-ai-sdk)        | JS/TS                      | React, Next.js, Vue, Svelte, Node.js와 함께 AI 기반 애플리케이션 구축을 돕는 TypeScript 툴킷입니다.                                                                |
| [API](https://litefuse.ai/docs/api)                                         |                            | 공개 API를 직접 호출합니다. OpenAPI 명세가 제공됩니다.                                                                                                             |

### Litefuse와 통합된 패키지:

| 이름                                                                                 | 유형                | 설명                                                                                                        |
| ------------------------------------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Instructor](https://litefuse.ai/docs/integrations/instructor)                       | 라이브러리          | 구조화된 LLM 출력을(JSON, Pydantic) 얻기 위한 라이브러리입니다.                                             |
| [DSPy](https://litefuse.ai/docs/integrations/dspy)                                   | 라이브러리          | 언어 모델 프롬프트와 가중치를 체계적으로 최적화하는 프레임워크입니다.                                       |
| [Mirascope](https://litefuse.ai/docs/integrations/mirascope)                         | 라이브러리          | LLM 애플리케이션 구축을 위한 Python 툴킷입니다.                                                             |
| [Ollama](https://litefuse.ai/docs/integrations/ollama)                               | 모델 (로컬)         | 자신의 컴퓨터에서 오픈 소스 LLM을 손쉽게 실행할 수 있습니다.                                                |
| [Amazon Bedrock](https://litefuse.ai/docs/integrations/amazon-bedrock)               | 모델                | AWS에서 기본 및 파인튜닝된 모델을 실행합니다.                                                               |
| [Google VertexAI and Gemini](https://litefuse.ai/docs/integrations/google-vertex-ai) | 모델                | Google에서 기본 및 파인튜닝된 모델을 실행합니다.                                                            |
| [AutoGen](https://litefuse.ai/docs/integrations/autogen)                             | 에이전트 프레임워크 | 분산 에이전트 구축을 위한 오픈 소스 LLM 플랫폼입니다.                                                       |
| [Flowise](https://litefuse.ai/docs/integrations/flowise)                             | 채팅/에이전트 UI    | 맞춤형 LLM 플로우를 위한 JS/TS 코드 없는(no-code) 빌더입니다.                                               |
| [Langflow](https://litefuse.ai/docs/integrations/langflow)                           | 채팅/에이전트 UI    | react-flow를 활용하여 실험 및 프로토타이핑을 손쉽게 할 수 있도록 디자인된 LangChain용 Python 기반 UI입니다. |
| [Dify](https://litefuse.ai/docs/integrations/dify)                                   | 채팅/에이전트 UI    | 코드 없는 빌더와 함께 제공되는 오픈 소스 LLM 애플리케이션 개발 플랫폼입니다.                                |
| [OpenWebUI](https://litefuse.ai/docs/integrations/openwebui)                         | 채팅/에이전트 UI    | 셀프 호스팅 및 로컬 모델 등 다양한 LLM 실행기를 지원하는 셀프 호스팅 LLM 채팅 웹 UI입니다.                  |
| [Promptfoo](https://litefuse.ai/docs/integrations/promptfoo)                         | 도구                | 오픈 소스 LLM 테스트 플랫폼입니다.                                                                          |
| [LobeChat](https://litefuse.ai/docs/integrations/lobechat)                           | 채팅/에이전트 UI    | 오픈 소스 챗봇 플랫폼입니다.                                                                                |
| [Vapi](https://litefuse.ai/docs/integrations/vapi)                                   | 플랫폼              | 오픈 소스 음성 AI 플랫폼입니다.                                                                             |
| [Inferable](https://litefuse.ai/docs/integrations/other/inferable)                   | 에이전트            | 분산 에이전트 구축을 위한 오픈 소스 LLM 플랫폼입니다.                                                       |
| [Gradio](https://litefuse.ai/docs/integrations/other/gradio)                         | 채팅/에이전트 UI    | 채팅 UI와 같은 웹 인터페이스 구축을 위한 오픈 소스 Python 라이브러리입니다.                                 |
| [Goose](https://litefuse.ai/docs/integrations/goose)                                 | 에이전트            | 분산 에이전트 구축을 위한 오픈 소스 LLM 플랫폼입니다.                                                       |
| [smolagents](https://litefuse.ai/docs/integrations/smolagents)                       | 에이전트            | 오픈 소스 AI 에이전트 프레임워크입니다.                                                                     |
| [CrewAI](https://litefuse.ai/docs/integrations/crewai)                               | 에이전트            | 에이전트 간 협업 및 도구 사용을 위한 다중 에이전트 프레임워크입니다.                                        |

## 🚀 빠른 시작

앱에 계측을 추가하고 Litefuse에 trace 데이터를 수집하여, LLM 호출 및 검색, 임베딩, 에이전트 동작과 같은 애플리케이션 로직을 추적해보세요. 복잡한 로그와 사용자 세션을 확인하여 디버깅할 수 있습니다.

### 1️⃣ 새 프로젝트 생성

1. [Litefuse 계정 생성](https://cloud.litefuse.ai/auth/sign-up) 또는 [셀프 호스트](https://litefuse.ai/self-hosting)
2. 새 프로젝트를 생성합니다.
3. 프로젝트 설정에서 새로운 API 자격 증명을 생성합니다.

### 2️⃣ 첫 번째 LLM 호출 기록하기

[`@observe()` 데코레이터](https://litefuse.ai/docs/sdk/python/decorators)를 사용하면 Python LLM 애플리케이션의 추적이 매우 간편해집니다. 이 빠른 시작 예제에서는 Litefuse [OpenAI 통합](https://litefuse.ai/integrations/model-providers/openai-py)을 사용하여 모든 모델 파라미터를 자동으로 캡처합니다.

> [!TIP]
> OpenAI를 사용하지 않으시다면, 다른 모델 및 프레임워크의 로그 기록 방법은 [문서](https://litefuse.ai/docs/get-started#log-your-first-llm-call-to-Litefuse)를 참조하세요.

```bash
pip install Litefuse openai
```

```bash filename=".env"
Litefuse_SECRET_KEY="sk-lf-..."
Litefuse_PUBLIC_KEY="pk-lf-..."
LANGFUSE_BASE_URL="https://litefuse.cloud"
```

```python:main.py
from Litefuse import observe
from Litefuse.openai import openai # OpenAI integration

@observe()
def story():
    return openai.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "What is Litefuse?"}],
    ).choices[0].message.content

@observe()
def main():
    return story()

main()
```

### 3️⃣ Litefuse에서 trace 확인하기

Litefuse에서 LLM 호출 및 애플리케이션의 기타 로직에 대한 trace를 확인할 수 있습니다.

![Example trace in Litefuse](https://litefuse.ai/images/docs/github-readme/github-example-trace.png)

_[Litefuse의 공개 예제 trace](https://cloud.litefuse.ai/project/cloramnkj0002jz088vzn1ja4/traces/2cec01e3-3dc2-472f-afcf-3b968cf0c1f4?timestamp=2025-02-10T14%3A27%3A30.275Z&observation=cb5ff844-07ef-41e6-b8e2-6c64344bc13b)_

> [!TIP]
>
> Litefuse의 trace에 대해 더 알아보거나 [인터랙티브 데모](https://litefuse.ai/docs/demo)에서 직접 체험해보세요.

## ⭐️ 별을 눌러주세요

![star-Litefuse-on-github](https://github.com/user-attachments/assets/79a1d816-d229-4526-aecc-097d4a19f1ad)

## 💭 지원

질문에 대한 답변을 찾는 방법:

- 우리의 [문서](https://litefuse.ai/docs)는 답을 찾기 위한 최적의 장소입니다. 문서가 매우 포괄적이며, 유지보수에 많은 노력을 기울이고 있습니다. GitHub를 통해 문서 수정 제안도 가능합니다.
- [Litefuse FAQ](https://litefuse.ai/faq)에서는 가장 흔한 질문에 대해 답변하고 있습니다.
- 질문에 즉각적인 답변이 필요하다면 [Ask AI](https://litefuse.ai/docs/ask-ai)를 사용해보세요.

지원 채널:

- **GitHub Discussions의 [공개 Q&A](https://github.com/orgs/litefuse/discussions/categories/support)** 에 질문을 남겨주세요. 가능한 한 많은 세부 사항(예: 코드 스니펫, 스크린샷, 배경 정보)을 포함해 질문해 주시기 바랍니다.
- [기능 요청](https://github.com/orgs/litefuse/discussions/categories/ideas)을 남겨주세요.
- [버그 신고](https://github.com/selectdb/litefuse/issues)는 GitHub Issues를 통해 해주세요.
- 긴급한 문의는 앱 내 채팅 위젯을 통해 연락 바랍니다.

## 🤝 기여하기

여러분의 기여를 환영합니다!

- GitHub Discussions의 [아이디어](https://github.com/orgs/Litefuse/discussions/categories/ideas)에 투표해보세요.
- GitHub Issues에서 이슈를 제기하고 댓글을 남겨주세요.
- PR을 제출하세요 – 개발 환경 설정 방법 등 자세한 내용은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요.

## 🙏 이 Fork에 대하여

> **이 Fork에 대하여** — Litefuse는 [langfuse/langfuse](https://github.com/langfuse/langfuse)의 fork이며, 원본 작업을 만들어 주신 Langfuse 팀에 깊이 감사드립니다. Litefuse는 분석 백엔드를 [Apache Doris](https://doris.apache.org/)로 교체하고 상위 Langfuse API와의 wire-protocol 호환성을 유지하므로, 공식 `langfuse` / `@langfuse/*` SDK와 Langfuse 호환 OpenTelemetry exporter는 코드 변경 없이 Litefuse에서 동작합니다 — host만 Litefuse 엔드포인트로 가리키면 됩니다.

## 🥇 라이선스

이 저장소는 MIT 라이선스가 적용됩니다. 자세한 내용은 [LICENSE](LICENSE)를 확인하세요.

## ⭐️ 별(Star) 히스토리

<a href="https://star-history.com/#Litefuse/Litefuse&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Litefuse/Litefuse&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Litefuse/Litefuse&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Litefuse/Litefuse&type=Date" style="border-radius: 15px;" />
 </picture>
</a>

## ❤️ Litefuse를 사용하는 오픈 소스 프로젝트

별(star) 수를 기준으로 순위가 매겨진 Litefuse를 사용하는 상위 오픈 소스 Python 프로젝트들 ([출처](https://github.com/selectdb/Litefuse-doris-docs/blob/main/components-mdx/dependents)):

| 저장소                                                                                                                                                                                                                                                              |    별 |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----: |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/127165244?s=40&v=4" width="20" height="20" alt=""> &nbsp; [langgenius](https://github.com/langgenius) / [dify](https://github.com/langgenius/dify)                                            | 54865 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/158137808?s=40&v=4" width="20" height="20" alt=""> &nbsp; [open-webui](https://github.com/open-webui) / [open-webui](https://github.com/open-webui/open-webui)                                | 51531 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/131470832?s=40&v=4" width="20" height="20" alt=""> &nbsp; [lobehub](https://github.com/lobehub) / [lobe-chat](https://github.com/lobehub/lobe-chat)                                           | 49003 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/85702467?s=40&v=4" width="20" height="20" alt=""> &nbsp; [langflow-ai](https://github.com/langflow-ai) / [langflow](https://github.com/langflow-ai/langflow)                                  | 39093 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/130722866?s=40&v=4" width="20" height="20" alt=""> &nbsp; [run-llama](https://github.com/run-llama) / [llama_index](https://github.com/run-llama/llama_index)                                 | 37368 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/169401942?s=40&v=4" width="20" height="20" alt=""> &nbsp; [danny-avila](https://github.com/danny-avila) / [LibreChat](https://github.com/danny-avila/LibreChat)                               | 33142 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/139558948?s=40&v=4" width="20" height="20" alt=""> &nbsp; [chatchat-space](https://github.com/chatchat-space) / [Langchain-Chatchat](https://github.com/chatchat-space/Langchain-Chatchat)    | 32486 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/128289781?s=40&v=4" width="20" height="20" alt=""> &nbsp; [FlowiseAI](https://github.com/FlowiseAI) / [Flowise](https://github.com/FlowiseAI/Flowise)                                         | 32448 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/31035808?s=40&v=4" width="20" height="20" alt=""> &nbsp; [mindsdb](https://github.com/mindsdb) / [mindsdb](https://github.com/mindsdb/mindsdb)                                                | 26931 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/119600397?s=40&v=4" width="20" height="20" alt=""> &nbsp; [twentyhq](https://github.com/twentyhq) / [twenty](https://github.com/twentyhq/twenty)                                              | 24195 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/60330232?s=40&v=4" width="20" height="20" alt=""> &nbsp; [PostHog](https://github.com/PostHog) / [posthog](https://github.com/PostHog/posthog)                                                | 22618 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/121462774?s=40&v=4" width="20" height="20" alt=""> &nbsp; [BerriAI](https://github.com/BerriAI) / [litellm](https://github.com/BerriAI/litellm)                                               | 15151 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/179202840?s=40&v=4" width="20" height="20" alt=""> &nbsp; [mediar-ai](https://github.com/mediar-ai) / [screenpipe](https://github.com/mediar-ai/screenpipe)                                   | 11037 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/105877416?s=40&v=4" width="20" height="20" alt=""> &nbsp; [formbricks](https://github.com/formbricks) / [formbricks](https://github.com/formbricks/formbricks)                                |  9386 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/76263028?s=40&v=4" width="20" height="20" alt=""> &nbsp; [anthropics](https://github.com/anthropics) / [courses](https://github.com/anthropics/courses)                                       |  8385 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/78410652?s=40&v=4" width="20" height="20" alt=""> &nbsp; [GreyDGL](https://github.com/GreyDGL) / [PentestGPT](https://github.com/GreyDGL/PentestGPT)                                          |  7374 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/152537519?s=40&v=4" width="20" height="20" alt=""> &nbsp; [superagent-ai](https://github.com/superagent-ai) / [superagent](https://github.com/superagent-ai/superagent)                       |  5391 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/137907881?s=40&v=4" width="20" height="20" alt=""> &nbsp; [promptfoo](https://github.com/promptfoo) / [promptfoo](https://github.com/promptfoo/promptfoo)                                     |  4976 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/157326433?s=40&v=4" width="20" height="20" alt=""> &nbsp; [onlook-dev](https://github.com/onlook-dev) / [onlook](https://github.com/onlook-dev/onlook)                                        |  4141 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/7250217?s=40&v=4" width="20" height="20" alt=""> &nbsp; [Canner](https://github.com/Canner) / [WrenAI](https://github.com/Canner/WrenAI)                                                      |  2526 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/11855343?s=40&v=4" width="20" height="20" alt=""> &nbsp; [pingcap](https://github.com/pingcap) / [autoflow](https://github.com/pingcap/autoflow)                                              |  2061 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/85268109?s=40&v=4" width="20" height="20" alt=""> &nbsp; [MLSysOps](https://github.com/MLSysOps) / [MLE-agent](https://github.com/MLSysOps/MLE-agent)                                         |  1161 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/158137808?s=40&v=4" width="20" height="20" alt=""> &nbsp; [open-webui](https://github.com/open-webui) / [pipelines](https://github.com/open-webui/pipelines)                                  |  1100 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/18422723?s=40&v=4" width="20" height="20" alt=""> &nbsp; [alishobeiri](https://github.com/alishobeiri) / [thread](https://github.com/alishobeiri/thread)                                      |  1074 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/125468716?s=40&v=4" width="20" height="20" alt=""> &nbsp; [topoteretes](https://github.com/topoteretes) / [cognee](https://github.com/topoteretes/cognee)                                     |   971 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/188657705?s=40&v=4" width="20" height="20" alt=""> &nbsp; [bRAGAI](https://github.com/bRAGAI) / [bRAG-langchain](https://github.com/bRAGAI/bRAG-langchain)                                    |   823 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/169500408?s=40&v=4" width="20" height="20" alt=""> &nbsp; [opslane](https://github.com/opslane) / [opslane](https://github.com/opslane/opslane)                                               |   677 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/151867818?s=40&v=4" width="20" height="20" alt=""> &nbsp; [dynamiq-ai](https://github.com/dynamiq-ai) / [dynamiq](https://github.com/dynamiq-ai/dynamiq)                                      |   639 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/48585267?s=40&v=4" width="20" height="20" alt=""> &nbsp; [theopenconversationkit](https://github.com/theopenconversationkit) / [tock](https://github.com/theopenconversationkit/tock)         |   514 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/20493493?s=40&v=4" width="20" height="20" alt=""> &nbsp; [andysingal](https://github.com/andysingal) / [llm-course](https://github.com/andysingal/llm-course)                                 |   394 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/132396805?s=40&v=4" width="20" height="20" alt=""> &nbsp; [phospho-app](https://github.com/phospho-app) / [phospho](https://github.com/phospho-app/phospho)                                   |   384 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/178644984?s=40&v=4" width="20" height="20" alt=""> &nbsp; [sentient-engineering](https://github.com/sentient-engineering) / [agent-q](https://github.com/sentient-engineering/agent-q)        |   370 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/168552753?s=40&v=4" width="20" height="20" alt=""> &nbsp; [sql-agi](https://github.com/sql-agi) / [DB-GPT](https://github.com/sql-agi/DB-GPT)                                                 |   324 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/60330232?s=40&v=4" width="20" height="20" alt=""> &nbsp; [PostHog](https://github.com/PostHog) / [posthog-foss](https://github.com/PostHog/posthog-foss)                                      |   305 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/154247157?s=40&v=4" width="20" height="20" alt=""> &nbsp; [vespperhq](https://github.com/vespperhq) / [vespper](https://github.com/vespperhq/vespper)                                         |   304 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/185116535?s=40&v=4" width="20" height="20" alt=""> &nbsp; [block](https://github.com/block) / [goose](https://github.com/block/goose)                                                         |   295 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/609489?s=40&v=4" width="20" height="20" alt=""> &nbsp; [aorwall](https://github.com/aorwall) / [moatless-tools](https://github.com/aorwall/moatless-tools)                                    |   291 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/2357342?s=40&v=4" width="20" height="20" alt=""> &nbsp; [dmayboroda](https://github.com/dmayboroda) / [minima](https://github.com/dmayboroda/minima)                                          |   221 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/66303003?s=40&v=4" width="20" height="20" alt=""> &nbsp; [RobotecAI](https://github.com/RobotecAI) / [rai](https://github.com/RobotecAI/rai)                                                  |   172 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/148684274?s=40&v=4" width="20" height="20" alt=""> &nbsp; [i-am-alice](https://github.com/i-am-alice) / [3rd-devs](https://github.com/i-am-alice/3rd-devs)                                    |   148 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/171735272?s=40&v=4" width="20" height="20" alt=""> &nbsp; [8090-inc](https://github.com/8090-inc) / [xrx-sample-apps](https://github.com/8090-inc/xrx-sample-apps)                            |   138 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/104478511?s=40&v=4" width="20" height="20" alt=""> &nbsp; [babelcloud](https://github.com/babelcloud) / [LLM-RGB](https://github.com/babelcloud/LLM-RGB)                                      |   135 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/15125613?s=40&v=4" width="20" height="20" alt=""> &nbsp; [souzatharsis](https://github.com/souzatharsis) / [tamingLLMs](https://github.com/souzatharsis/tamingLLMs)                           |   129 |
| <img class="avatar mr-2" src="https://avatars.githubusercontent.com/u/51827949?s=40&v=4" width="20" height="20" alt=""> &nbsp; [deepset-ai](https://github.com/deepset-ai) / [haystack-core-integrations](https://github.com/deepset-ai/haystack-core-integrations) |   126 |

## 🔒 보안 & 개인정보 보호

우리는 데이터 보안과 개인정보 보호를 매우 중요하게 생각합니다. 자세한 내용은 [Security and Privacy](https://litefuse.ai/security) 페이지를 참조하세요.

### 텔레메트리

기본적으로 Litefuse는 자체 호스팅 인스턴스의 기본 사용 통계를 중앙 서버(PostHog)로 자동 보고합니다.

이를 통해:

1. Litefuse가 어떻게 사용되는지 이해하고, 가장 관련성 높은 기능을 개선할 수 있습니다.
2. 내부 및 외부(예: 자금 조달) 보고를 위한 전체 사용량을 추적할 수 있습니다.

수집된 데이터는 제3자와 공유되지 않으며 민감한 정보를 포함하지 않습니다. 이에 대해 매우 투명하게 공개하고 있으며, 수집되는 정확한 데이터는 [여기](/web/src/features/telemetry/index.ts)에서 확인할 수 있습니다.

환경 변수 `TELEMETRY_ENABLED=false`를 설정하여 옵트아웃할 수 있습니다.
