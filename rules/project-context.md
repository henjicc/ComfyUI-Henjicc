---
template_state: ready
---

# 项目上下文

## 项目范围

- 本项目是 ComfyUI 自定义节点包，只维护节点实现、配套前端、翻译、依赖声明、开发规则与必要测试。
- 个人 ComfyUI 工作流、素材、生成结果、录制教程、跑分、模型选型、第三方补丁和宿主维护记录均不属于本仓库。开发联调所需的最小执行图使用合成数据，保留在相应测试中。
- 本项目不默认承担用户日常 ComfyUI 操作、工作流整理、模型下载或宿主环境管理。新节点仍须用户明确要求，不能通过维护规则扩大授权。
- 节点包运行于 ComfyUI Python 宿主，使用 V3 接口；前端是宿主扩展，无独立网站、构建工程或常驻服务。模型加载、量化和采样由相应原生或第三方节点负责。
- Python 版本与依赖以 `pyproject.toml` 为准，许可证见 `LICENSE`。Registry 发布信息以 `[tool.comfy]` 与官方发布页面为准；尚未承诺的宿主版本、多平台兼容，不按某台电脑的运行记录推定。

## 权威入口

| 入口 | 职责 |
|---|---|
| `__init__.py` | `comfy_entrypoint`、十个节点注册、资源路由及提交回调 |
| `library/image_library.py`、`library/audio_waveform.py` | input/output/temp 资源访问、评分标签及有界音频波形缓存 |
| `media/media.py`、`media/media_nodes.py` | 素材序列化、稳定引用、路径边界、解码、模型连接识别及条件适配 |
| `image/image_collection.py`、`image/image_nodes.py` | 有界图片读取、缩放、图片列表与十槽分配 |
| `image/generation_presets.py`、`image/preset_nodes.py` | 预设、尺寸计算及共用预览接口 |
| `video/video_preprocessing.py`、`video/video_nodes.py` | MiniMax H3 素材时序及同步音画输出 |
| `audio/music.py`、`audio/music_nodes.py` | 标准 AUDIO 的人声与伴奏混音 |
| `text/omni.py`、`text/omni_nodes.py` | 本地 Qwen2.5-Omni 联合素材理解 |
| `text/visual_prompt.py`、`text/visual_prompt_nodes.py` | Qwen3-VL 原图/视频拼图理解及提示词优化 |
| `web/`、`locales/` | 本包节点及已授权原生 LoadImage 增强的界面与中英文翻译 |
| `tests/` | 节点计算、边界、请求安全及前端交互回归 |

节点与配套处理逻辑按 `image/`、`media/`、`video/`、`audio/`、`text/` 分类，共享资源服务位于 `library/`。根目录仅保留 Python 注册入口；分类包的 `__init__.py` 保持轻量，由根入口显式导入，不扫描注册或保留旧平铺模块作为兼容壳。

## 持续保留的实现约束

- 原生 LoadImage 只增强前端选图，不覆盖后端。资源库复用宿主配置的 input/output/temp，评分标签按来源隔离；输出与临时素材选用时有界复制到 input，删除仅作用于 input 且必须确认。
- `HENJICC_MEDIA` 保存稳定素材 ID、引用和可选预设；删除素材不重定向引用，替换保留身份。视频原声显式开启，引用编号随实际类型和顺序编译；用户提示词本身不翻译。
- 模型 profile 以实际执行连接派生。前端通过宿主 `graphToPrompt` 解析虚拟路由，后端以 hidden prompt 为权威；HTTP 提交回调仅更新执行输入中的连接缓存标记，不改保存的 UI 工作流。
- 超级输入按需显示输出，后端输出顺序固定。提交回调将 `_output_names` 转为固定编号；没有映射的旧 API 图保持原编号，未解析映射拒绝执行。直接嵌入执行器需调用 `prepare_media_prompt` 或提供固定编号 API 图。
- `HenjiccQwenReferenceList` 保留内部 ID，实际为通用参考图处理，输出标准 IMAGE 列表并保留 RGBA、独立尺寸和顺序。十图限制属于千问及十槽分配器，不扩散到通用素材。
- 尺寸预设只管理提示词与可选尺寸，不干预模型、种子或采样参数。画板预览与执行共用 Python 规则；参考图预算独立于输出画布。未知变换不能用源图尺寸伪装执行结果。
- H3 素材和输出节点保持原生 24 fps、17k+5 模型网格及同步裁音画。参考图、源视频和音频支持范围以 schema 与执行校验为准，不将某个工作流的配方写成节点默认行为。
- Qwen3-VL 助手使用完整语言模型的图片路径，视频拼图不能称为原生视频推理。输出素材只更新提示词，保留引用、音频及预设；自动任务依据真实下游连接参与缓存。
- Omni 助手仅加载预先准备的本地模型，不自动下载或安装依赖；可选依赖及模型目录见 README。
- 控件状态通过宿主历史事务更新，撤销后操作当前实例；视图挂载身份不持久化。中英文界面跟随 `Comfy.Locale`，内部 ID、设置 ID 和用户内容不翻译。

## 开发与集成入口

- 安装目录为目标宿主的 `custom_nodes/ComfyUI-Henjicc`，可以是当前工程的目录联接；每次联调按实际文件和进程核验，不假定同名已加载目录就是当前源码。
- 使用实际宿主的 Python，并将宿主根目录加入 `PYTHONPATH`，执行 `-m unittest discover -s tests -v`；前端使用 `node --test tests/*.test.mjs`。不在这里保存个人绝对路径、固定端口、硬件清单或本机测试流水账。
- 控制宿主前按 [控制操作规程](comfyui-nodes.md#控制操作规程) 核验服务、队列及活动页面。纯文档和规则变更无需启动服务；节点联调仅运行任务所需的最小图，不修改用户日常工作流。
- 源码、schema、依赖配置和测试是实现事实入口；README 说明节点功能，规则维护流程见 [rule-maintenance.md](rule-maintenance.md)。`ready` 保持不变，日常整理不重复初始化。
- Registry 发布入口为 `.github/workflows/publish.yml`，仅 main 分支版本号变化或手动触发时执行，已上传版本跳过；版本在 `pyproject.toml`，发布说明在 `CHANGELOG.md`。发布依赖 GitHub Actions secret `REGISTRY_ACCESS_TOKEN`，密钥不得提交；上传成功与 Registry 审核、Manager 可安装状态分别核验。
