#!/bin/sh
# 抖音云容器服务固定执行 /opt/application/run.sh（忽略镜像 CMD）。
cd /opt/application
exec node --enable-source-maps server.js
