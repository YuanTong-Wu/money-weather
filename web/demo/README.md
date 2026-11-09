# 【合成演示】Money Weather

【合成演示】全部地区、公司、价格、成交量和资金天气均为从零编写的数学样本。不是行情，不对应真实证券、用户持仓或真实资金；不代表预测或投资收益。

生成：`python3 scripts/create_demo.py`；32 日版加 `--days 32`。相同参数产生完全相同的文件字节，`--check` 核对磁盘文件。

从项目的 `web/` 目录用 Python 静态服务器打开，访问 `http://127.0.0.1:8000/?data=demo#/world`。地区：`#/world/demo-dawn`；个股：`#/stock/FICTA`。地图选择“抽象”，2D/3D 使用同一组时间序列。

本脚本不运行服务器、行情更新、Claude 或其他 AI。不要用 `server.py` 或 `update.sh` 启动此纯静态演示。前端现有独立 API/地理资源入口并非由本生成器禁用；严格浏览器零 API 模式须由父任务处理。

所有文件形状见 `demo-info.json`；每份文件的 SHA-256 见 `manifest.json`。未生成新闻、AI 回答、预测命中率、真实资金或回测证明。
