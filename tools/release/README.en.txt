Yimsg 0.1 Quick Start
=====================

1. Extract the complete archive.
2. Open a terminal in the extracted directory.
3. Run:

   Windows:  .\yimsg.exe
   Linux:    ./yimsg
   macOS:    ./yimsg

4. Open http://127.0.0.1:38081/ in a browser.

No configuration file is required by default. Data is stored in the data
directory beside the executable.

Allow devices on a LAN or public network to connect:

   yimsg --listen 0.0.0.0:38081

Choose a data directory:

   yimsg --data-dir /path/to/data

For production TLS, certificates, or other advanced settings, copy
config.example.toml, uncomment only the settings you need, and run:

   yimsg --config config.toml

All options: yimsg --help
Version: yimsg --version

Before exposing the service publicly, configure TLS and a firewall. Yimsg 0.1
uses a single-machine, single-process architecture. One deployment can serve
many locations, devices, websites, and business systems, but it is not a cluster.
