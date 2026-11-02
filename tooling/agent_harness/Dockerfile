FROM node:24-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates git openssh-client gh python3 python3-venv jq curl \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1002 whaleorcale && \
    useradd -u 1001 -g 1002 -d /home/whaleorcale -m -s /bin/bash whaleorcale
ENV HOME=/home/whaleorcale
ENV XDG_CONFIG_HOME=/home/whaleorcale/.config
ENV PATH=/usr/local/bin:/usr/bin:/bin
ENV GIT_TERMINAL_PROMPT=0
USER 1001:1002
WORKDIR /opt/harness
ENTRYPOINT ["/bin/bash","-lc","git config --global user.name quantm-zeus && git config --global user.email quantm-zeus@users.noreply.github.com && git config --global url.https://github.com/.insteadOf git@github.com: && gh auth setup-git && exec python3 -u /opt/harness/supervisor.py run"]
