Yimsg 0.1 快速开始
==================

1. 解压整个压缩包。
2. 在解压目录打开终端。
3. 运行：

   Windows:  .\yimsg.exe
   Linux:    ./yimsg
   macOS:    ./yimsg

4. 浏览器访问 http://127.0.0.1:38081/。

默认无需配置文件，数据保存在解压目录的 data 文件夹中。

允许局域网或公网设备连接：

   yimsg --listen 0.0.0.0:38081

指定数据目录：

   yimsg --data-dir /path/to/data

生产环境如需 HTTPS、证书或其它高级配置，请复制 config.example.toml，
只取消需要覆盖的配置项，然后运行：

   yimsg --config config.toml

查看全部选项：yimsg --help
查看版本：yimsg --version

提示：开放公网访问前，请配置 TLS 和防火墙；Yimsg 0.1 是单机、单进程架构，
一套部署可以同时服务多个地点、终端、网站和业务系统，但不是多机集群。
