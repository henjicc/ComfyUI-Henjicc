# ComfyUI-Henjicc 简明安装指南

工作流提示缺少 `Henjicc...` 节点时，安装 **ComfyUI-Henjicc · 痕继痕迹**。需要 Python 3.10 或以上，以及支持 V3 节点接口的 ComfyUI。

## 导入工作流，快速安装缺失节点

1. 将分享的工作流 `.json` 文件拖入 ComfyUI，或通过菜单打开工作流。
2. 如果提示缺少节点，打开 **Manager → 安装缺失节点（Install Missing Custom Nodes）**，找到本包后点击安装。
3. 也可以在 Manager 的自定义节点列表搜索 `comfyui-henjicc` 或 `Henjicc` 安装；[Registry 节点页](https://registry.comfy.org/zh/publishers/henjicc/nodes/comfyui-henjicc)可查看发布版本。
4. 安装完成后重启 ComfyUI、刷新网页，再打开工作流。

若版本仍待审核（Pending）、被标记需复核（Flagged）、Manager 目录未同步，或缺失节点列表没有识别到本包，可能暂时搜不到或无法通过 Manager 安装。可先查看 Registry 状态，并按下面的方法手动安装。工作流里其他作者的节点也需分别安装；模型权重需另行准备。

## 手动安装

### 1. 下载节点

打开 [节点仓库](https://github.com/henjicc/ComfyUI-Henjicc)，点击 **Code → Download ZIP**，或[直接下载 ZIP](https://github.com/henjicc/ComfyUI-Henjicc/archive/refs/heads/main.zip)。

解压后，将文件夹改名为 `ComfyUI-Henjicc`，放入 ComfyUI 的 `custom_nodes` 目录。确认文件位置是：

```text
ComfyUI/custom_nodes/ComfyUI-Henjicc/__init__.py
```

注意不要多套一层文件夹。

### 2. 安装依赖

使用 **ComfyUI 自己的 Python 环境**执行：

```shell
python -m pip install aiohttp av numpy Pillow
```

如果使用标准 Windows 便携版，且根目录中有 `python_embeded` 文件夹，在便携版根目录打开 PowerShell，执行：

```powershell
.\python_embeded\python.exe -m pip install aiohttp av numpy Pillow
```

### 3. 重启并打开工作流

重启 ComfyUI，刷新网页，再打开工作流。在节点库搜索 `Henjicc`，能看到“超级输入”“尺寸画板”等节点，说明节点包已加载。

若仍提示缺少节点，先检查目录是否放对、依赖是否装进正确的 Python，以及启动窗口里是否有导入错误。

节点包不包含模型权重；工作流使用的千问、MiniMax 等模型需另外准备。Qwen2.5-Omni 助手另需可选依赖，详见 [完整 README](README.md)。
