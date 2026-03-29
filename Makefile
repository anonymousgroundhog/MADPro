.PHONY: setup build run clean copy-assets

MADSCANNER := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))/../MADScanner_AI
PROJECT_ROOT := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))

setup:
	@echo "Installing Python dependencies..."
	pip install -r requirements.txt
	@echo "Done. Run 'make copy-assets' to copy Soot jars and Android platforms."
	@echo "Then run 'make build' to build the Docker image."

copy-assets:
	@echo "Copying Soot jars from MADScanner_AI..."
	mkdir -p jar_libs
	cp $(MADSCANNER)/Jar_Libs/*.jar jar_libs/
	@echo "Copying Android platforms from MADScanner_AI..."
	mkdir -p android/platforms
	cp -r $(MADSCANNER)/Android/platforms/* android/platforms/
	@echo "Assets copied."

build:
	@echo "Building Docker image (madpro-injector)..."
	docker build -t madpro-injector -f $(PROJECT_ROOT)/docker/Dockerfile $(PROJECT_ROOT)
	@echo "Docker image built."

run:
	python3 main.py

clean:
	@echo "Removing Docker image..."
	-docker rmi madpro-injector 2>/dev/null || true
	@echo "Cleaning Python cache..."
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true
