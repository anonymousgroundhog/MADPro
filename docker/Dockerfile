FROM eclipse-temurin:17-jdk-jammy

# Install dependencies
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    unzip \
    zipalign \
    python3 \
    aapt \
    && rm -rf /var/lib/apt/lists/*

# Install apksigner from Android Build Tools
RUN wget -q https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar \
    -O /usr/local/lib/uber-apk-signer.jar

# Install apktool
RUN wget -q https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool \
    -O /usr/local/bin/apktool && chmod +x /usr/local/bin/apktool
RUN wget -q https://github.com/iBotPeaches/Apktool/releases/download/v2.9.3/apktool_2.9.3.jar \
    -O /usr/local/lib/apktool.jar

# Create app directory
WORKDIR /app

# Copy jar libraries
COPY jar_libs/ /app/jar_libs/

# Copy Android platforms
COPY android/platforms/ /app/android/platforms/

# Copy and compile LogInjector
COPY java/LogInjector.java /app/
RUN javac -cp "/app/jar_libs/*" -d /app /app/LogInjector.java && echo "LogInjector compiled successfully"

# Copy entrypoint
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
