# The Node.js pin is single-sourced in `.nvmrc`; keep this ARG in sync with it.
ARG NODE_VERSION=26.13.1
FROM node:${NODE_VERSION}-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    file \
    pkg-config \
    libssl-dev \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    patchelf \
    unzip \
  && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable \
  && rustup component add clippy rustfmt \
  && rustup target add aarch64-linux-android \
  && chmod -R a+rwX /usr/local/cargo /usr/local/rustup \
  && rustc --version \
  && cargo --version \
  && node --version \
  && npm --version

ENV JAVA_HOME=/opt/java
ENV PATH=$JAVA_HOME/bin:$PATH

RUN mkdir -p "$JAVA_HOME" \
  && curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse" \
      -o /tmp/jdk.tgz \
  && tar -xzf /tmp/jdk.tgz -C "$JAVA_HOME" --strip-components=1 \
  && rm /tmp/jdk.tgz \
  && java -version

# Android pins come from `.toolchain.json`, the same single source CI reads.
COPY .toolchain.json /tmp/.toolchain.json

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_SDK_TOOLS_VERSION=15859902

RUN node -e "
  const t = require('/tmp/.toolchain.json')
  const lines = [
    'ANDROID_NDK_VERSION=' + t.androidNdk,
    'ANDROID_PLATFORMS=' + t.androidPlatforms.join(' '),
    'ANDROID_BUILD_TOOLS=' + t.androidBuildTools.join(' '),
    'NDK_HOME=/opt/android-sdk/ndk/' + t.androidNdk,
  ]
  require('fs').writeFileSync('/tmp/android.env', lines.join('\\n') + '\\n')
"
ENV PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH

RUN curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_SDK_TOOLS_VERSION}_latest.zip" \
      -o /tmp/commandlinetools.zip \
  && mkdir -p "$ANDROID_HOME/cmdline-tools" \
  && unzip -q /tmp/commandlinetools.zip -d "$ANDROID_HOME/cmdline-tools" \
  && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
  && rm /tmp/commandlinetools.zip \
  && yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null \
  && . /tmp/android.env \
  && for platform in $ANDROID_PLATFORMS; do \
       "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platforms;android-$platform"; \
     done \
  && for build_tools in $ANDROID_BUILD_TOOLS; do \
       "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "build-tools;$build_tools"; \
     done \
  && "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
      "platform-tools" \
      "ndk;${ANDROID_NDK_VERSION}" \
  && chmod -R a+rwX "$ANDROID_HOME" \
  && /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager --list_installed

ENV PATH=/opt/java/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:$PATH

WORKDIR /work

CMD ["bash"]
