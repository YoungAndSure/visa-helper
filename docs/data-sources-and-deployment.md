# 数据来源与服务部署方案

## 1. 数据分层

系统中的数据分为三类，生命周期和可信度必须分开管理：

1. **用户材料**：用户选择的签证材料。原文件只在浏览器本地处理；发送后端的只能是用户确认过的脱敏 PDF/JPG。后端仅在隔离临时目录中处理，任务结束删除，不进入规则库或知识库。
2. **官方 Checklist 与规则**：用于判断“必须提交什么、格式是否合规”。这是确定性要求的唯一权威来源。
3. **经验知识库**：来自公开经验和网友反馈，只辅助发现风险、常见补件原因和易错点，不能覆盖官方规则，也不能单独产生确定性的材料缺失结论。

## 2. 官方资料来源与更新

来源优先级如下：

1. 目的国使领馆、移民局、外交部门发布的法规与材料清单；
2. 欧盟委员会、EUR-Lex 等适用于申根签证的法规和官方说明；
3. VFS Global 等受托签证中心针对申请地区发布的 Checklist；
4. 经人工核对的官方补充说明。

VFS 是重要入口，但不是最终裁决机构。规则记录不能只用“国家 + 签证类型”定位，至少使用：

```text
destination_country
+ visa_type
+ applicant_residence_country_or_region
+ jurisdiction_or_application_center
+ applicant_type
+ effective_date
```

第一阶段采用管理员手动下载和发布：

```text
下载原文件 -> 放入 data/rules/sources -> 解析为草稿
          -> 人工核对来源和规则边界 -> 发布到规则库
```

每条规则保存来源 URL/文件、发布日期、抓取时间、内容哈希、适用范围和版本。发布采用完整版本快照，禁止请求过程中直接加载未审核草稿。

第二阶段再增加自动监控：定期检查 URL、哈希和正文差异，由 Agent 生成变更建议，管理员确认后发布。自动抓取不等于自动生效。

参考官方资料：

- [EUR-Lex：欧盟签证法规](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELLAR%3A7c7813fc-473e-11ea-b81b-01aa75ed71a1)
- [EEAS：Schengen Visa Factsheet](https://www.eeas.europa.eu/sites/default/files/2025/documents/Schengen_Factsheet_WEB.pdf)

## 3. 网友反馈与风险知识库

小红书等社区内容只进入“风险知识库”，不直接生成官方 Checklist。首期不做无授权的全站爬取，采用：

- 管理员提交公开帖子 URL；
- 用户自愿提交并授权使用的经验；
- 获得授权的创作者内容；
- 后续接入平台明确提供且许可当前用途的 API。

目前小红书公开开放平台主要面向商家、商品和订单能力，不应假定存在可供批量抓取普通笔记的开放接口。入库时只保存结构化事实和必要的短摘要，删除用户名、联系方式等个人信息，不复制整篇正文和图片。

经验记录至少包含：国家、签证类型、申请地区、申请时间、问题类型、结构化结论、来源 URL、样本时间、样本量和置信度。由此生成的规则只能给出 `WARNING` 或建议人工核查，不能单独判定 `FAIL`。

参考：[小红书开放平台产品概览](https://school.xiaohongshu.com/en/open/product/summary.html)。

## 4. 部署选择

当前推荐 **腾讯云轻量应用服务器 + Docker Compose + 腾讯云容器镜像服务 TCR**，暂不使用函数式一键托管：

- 审核请求目前可能运行数分钟；
- Claude CLI、PDF 工具和后续 OCR 都依赖系统运行环境；
- 处理过程需要隔离临时目录，后续还会增加任务队列和 Worker；
- 容器部署更容易固定依赖、限制权限和复现故障。

首期拓扑：

```text
浏览器（本地预处理与脱敏）
        |
        | HTTPS：只上传用户确认的脱敏 PDF/JPG
        v
Nginx / TLS -> FastAPI -> Claude Agent
                    |          |
                    |          +-> 只读规则和后续知识库工具
                    +-> 临时材料目录（任务结束删除）
```

MVP 可以先让静态页面与 API 同源运行在一个容器中。正式上线前应把同步的 `/material-audit/run` 改为异步任务：上传后返回 `job_id`，Worker 执行，前端轮询或 SSE 读取进度；Redis 只存任务状态，不存长期用户材料。达到真实并发量后再考虑 TKE/Kubernetes。

若先部署到腾讯云香港地域，可用于无需中国大陆 ICP 备案的外部测试；部署到中国大陆并通过域名公开服务前，需要按腾讯云要求完成域名和 ICP 备案。地域、网络和备案要求以腾讯云当期文档为准：

- [轻量应用服务器使用 Docker](https://cloud.tencent.com/document/product/1207/60423)
- [轻量应用服务器容器管理](https://cloud.tencent.com/document/product/1207/60329)
- [腾讯云 ICP 备案](https://cloud.tencent.com/document/product/243/18910)

## 5. 镜像、密钥和运行数据

镜像包含后端代码、前端静态资源、解析后的 Checklist、规则种子、固定版本 Python 依赖、Claude CLI 和 PDF 渲染工具。镜像不包含：

- `ANTHROPIC_AUTH_TOKEN` 或任何云账号凭据；
- `backend/config/*.local.json`；
- 用户原文件、脱敏文件和浏览器本地数据库；
- 后端日志、报告、规则草稿或管理员下载的受限来源文件。

API Key 通过服务器上的 `.env` 或云密钥服务注入。容器内 `/tmp` 使用内存文件系统，停止容器即清空；持久卷只保存已发布规则和服务日志，不保存用户材料。

## 6. TCR 构建与发布

本仓库的 `deploy/Dockerfile` 默认构建 `linux/amd64` 生产镜像。腾讯云个人版 TCR 的基本流程是：初始化服务、创建全局唯一命名空间、创建私有仓库，然后登录、标记并推送镜像。

```bash
cp deploy/.env.example deploy/.env
# 只在服务器或本机 deploy/.env 中填 Key，不提交到 Git

docker login ccr.ccs.tencentyun.com --username='<腾讯云账号 ID>'
TCR_NAMESPACE='<命名空间>' deploy/tencent-tcr.sh push
```

脚本用当前 Git 提交短哈希作为不可变镜像标签，并在推送前先本地构建和健康检查。部署服务器再执行：

```bash
IMAGE_REF='ccr.ccs.tencentyun.com/<命名空间>/visa-helper:<提交哈希>' \
  docker compose -f deploy/docker-compose.yml up -d
```

个人版 TCR 适合首期；仓库应设为私有。轻量服务器控制台的“容器管理”只便捷选择个人版公开镜像，不适合私有业务代码；私有镜像应在服务器上登录 TCR 后用 Compose 拉取。需要源码自动构建、跨地域复制、镜像扫描和细粒度权限时再升级企业版。

腾讯云参考：[个人版 TCR 快速入门](https://cloud.tencent.com/document/product/1141/63910)、[企业版构建规则](https://cloud.tencent.com/document/product/1141/41811)。
