#!/bin/bash
# chittu demo box bootstrap — docs/runbooks/demo-deploy.md §3, automated.
# Runs once as root on first boot (cloud-init). Log: /var/log/cloud-init-output.log
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update

# Docker, upstream convenience script (demo-grade, same as the runbook).
curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu
systemctl enable --now docker

# Caddy, from its official apt repository (caddyserver.com/docs/install).
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
systemctl enable caddy

# The two directories the ship step (runbook §4) rsyncs into.
mkdir -p /srv/chittu-web /opt/chittu
chown ubuntu:ubuntu /srv/chittu-web /opt/chittu
