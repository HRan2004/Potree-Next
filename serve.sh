#!/bin/bash
# 启动文件服务器，暴露 pointcloud-webgpu-render 目录
# 端口 17420，启用 CORS，禁用缓存
cd /data/disk1/guohaoran/pointcloud-webgpu-render
npx -y http-server . -p 17420 --cors -c-1
