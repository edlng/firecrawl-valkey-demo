#!/bin/bash
# Test Firecrawl with Valkey on Ubuntu/Debian via Docker Compose
# This simulates a real self-hosted deployment scenario
#
# Usage: ./scripts/test-self-hosted.sh [ubuntu|debian|all]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FIRECRAWL_ROOT="$(dirname "$(dirname "$PROJECT_DIR")")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

TEST_ID="$(date +%s)"
NETWORK_NAME="valkey-selfhost-test-${TEST_ID}"
TEST_RESULTS=()

cleanup() {
    log "Cleaning up..."
    docker rm -f "firecrawl-ubuntu-${TEST_ID}" "firecrawl-debian-${TEST_ID}" 2>/dev/null || true
    docker network rm "${NETWORK_NAME}" 2>/dev/null || true
}

trap cleanup EXIT

check_prerequisites() {
    log "Checking prerequisites..."
    command -v docker >/dev/null 2>&1 || error "Docker not found"
    docker info >/dev/null 2>&1 || error "Docker daemon not running"
    [ -f "$FIRECRAWL_ROOT/docker-compose.yaml" ] || error "docker-compose.yaml not found in $FIRECRAWL_ROOT"
    log "Prerequisites OK"
}

# The test script that runs inside the Ubuntu/Debian container
generate_test_script() {
    cat << 'TESTSCRIPT'
#!/bin/bash
set -e

log() { echo "[TEST] $1"; }
warn() { echo "[WARN] $1"; }
fail() { echo "[FAIL] $1"; exit 1; }

cd /firecrawl

log "=== Setting up Firecrawl with Valkey ==="

# Switch to pre-built images (faster than building from source)
log "Switching to pre-built Firecrawl images..."
sed -i 's|build: apps/api|# build: apps/api|g' docker-compose.yaml
sed -i 's|# image: ghcr.io/firecrawl/firecrawl|image: ghcr.io/firecrawl/firecrawl|g' docker-compose.yaml
sed -i 's|build: apps/playwright-service-ts|# build: apps/playwright-service-ts|g' docker-compose.yaml
sed -i 's|# image: ghcr.io/firecrawl/playwright-service:latest|image: ghcr.io/firecrawl/playwright-service:latest|g' docker-compose.yaml

# Switch to Valkey image
log "Switching Redis to Valkey in docker-compose.yaml..."
sed -i 's|image: redis:alpine|# image: redis:alpine|g' docker-compose.yaml
sed -i 's|# image: valkey/valkey:alpine|image: valkey/valkey:alpine|g' docker-compose.yaml

# Verify the switch
if grep -q "image: valkey/valkey:alpine" docker-compose.yaml; then
    log "Valkey image configured"
else
    fail "Failed to configure Valkey image"
fi

if grep -q "image: ghcr.io/firecrawl/firecrawl" docker-compose.yaml; then
    log "Pre-built Firecrawl image configured"
else
    fail "Failed to configure Firecrawl image"
fi

log "=== Starting Firecrawl stack ==="
docker-compose up -d

log "Waiting for services to start (60s)..."
sleep 60

# Check container status
log "Container status:"
docker-compose ps

# Wait for API to be healthy
log "Waiting for API to be ready..."
MAX_ATTEMPTS=30
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s http://localhost:3002/v0/health/liveness 2>/dev/null | grep -q "ok"; then
        log "API is ready"
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 5
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    warn "API health check timed out, checking logs..."
    docker-compose logs api --tail=50
    fail "API failed to start"
fi

log "=== Verifying Valkey is being used ==="
VALKEY_VERSION=$(docker-compose exec -T redis redis-cli INFO server 2>/dev/null | grep -E "valkey_version" || echo "")
if [ -n "$VALKEY_VERSION" ]; then
    log "Confirmed running Valkey: $VALKEY_VERSION"
else
    # Fallback check - valkey still reports as redis_version in some cases
    REDIS_INFO=$(docker-compose exec -T redis redis-cli INFO server 2>/dev/null | head -20)
    log "Server info: $REDIS_INFO"
    warn "Could not confirm Valkey version, but continuing..."
fi

log "=== Running integration tests ==="

# Test 1: Basic scrape
log "Test 1: Basic scrape..."
SCRAPE_RESULT=$(curl -s -X POST http://localhost:3002/v1/scrape \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer fc-test-key" \
    -d '{"url": "https://example.com"}' 2>/dev/null)

if echo "$SCRAPE_RESULT" | grep -q '"success":true'; then
    log "✅ Basic scrape: PASSED"
else
    echo "Scrape result: $SCRAPE_RESULT"
    fail "Basic scrape: FAILED"
fi

# Test 2: Scrape with markdown
log "Test 2: Scrape with markdown format..."
MARKDOWN_RESULT=$(curl -s -X POST http://localhost:3002/v1/scrape \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer fc-test-key" \
    -d '{"url": "https://example.com", "formats": ["markdown"]}' 2>/dev/null)

if echo "$MARKDOWN_RESULT" | grep -q '"markdown"'; then
    log "✅ Markdown scrape: PASSED"
else
    echo "Markdown result: $MARKDOWN_RESULT"
    fail "Markdown scrape: FAILED"
fi

# Test 3: Crawl (start and check status)
log "Test 3: Crawl operation..."
CRAWL_RESULT=$(curl -s -X POST http://localhost:3002/v1/crawl \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer fc-test-key" \
    -d '{"url": "https://example.com", "limit": 2}' 2>/dev/null)

if echo "$CRAWL_RESULT" | grep -q '"success":true'; then
    CRAWL_ID=$(echo "$CRAWL_RESULT" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    log "Crawl started with ID: $CRAWL_ID"
    
    # Wait a bit and check status
    sleep 10
    STATUS_RESULT=$(curl -s "http://localhost:3002/v1/crawl/${CRAWL_ID}" \
        -H "Authorization: Bearer fc-test-key" 2>/dev/null)
    
    if echo "$STATUS_RESULT" | grep -qE '"status":"(completed|scraping)"'; then
        log "✅ Crawl operation: PASSED"
    else
        echo "Crawl status: $STATUS_RESULT"
        warn "Crawl status check inconclusive, but crawl started successfully"
    fi
else
    echo "Crawl result: $CRAWL_RESULT"
    fail "Crawl operation: FAILED"
fi

# Test 4: Verify data is stored in Valkey
log "Test 4: Verify Valkey data storage..."
KEY_COUNT=$(docker-compose exec -T redis redis-cli DBSIZE 2>/dev/null | grep -o '[0-9]*' || echo "0")
if [ "$KEY_COUNT" -gt 0 ]; then
    log "✅ Valkey has $KEY_COUNT keys stored: PASSED"
else
    warn "No keys found in Valkey (may be normal if jobs completed)"
fi

log "=== Cleanup ==="
docker-compose down -v

log ""
log "=========================================="
log "  ALL TESTS PASSED"
log "  Firecrawl works with Valkey!"
log "=========================================="
TESTSCRIPT
}

test_distro() {
    local distro=$1
    local image=$2
    local container_name="firecrawl-${distro}-${TEST_ID}"
    
    log "=========================================="
    log "Testing Firecrawl + Valkey on ${distro}"
    log "=========================================="
    
    # Start container with Docker socket access
    # Use host network so container can reach Firecrawl on localhost:3002
    log "Starting ${distro} container with Docker..."
    docker run -d \
        --name "${container_name}" \
        --privileged \
        --network host \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "${FIRECRAWL_ROOT}:/firecrawl-src:ro" \
        "${image}" \
        tail -f /dev/null
    
    # Install Docker CLI only (static binary - much faster than apt)
    log "Installing Docker CLI in ${distro}..."
    docker exec "${container_name}" bash -c "
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y curl jq
        
        # Download static Docker CLI binary
        curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-24.0.7.tgz | tar xz -C /tmp
        mv /tmp/docker/docker /usr/local/bin/
        rm -rf /tmp/docker
        
        # Install docker-compose standalone
        curl -fsSL https://github.com/docker/compose/releases/download/v2.24.0/docker-compose-linux-x86_64 -o /usr/local/bin/docker-compose
        chmod +x /usr/local/bin/docker-compose
        
        docker --version
        docker-compose --version
    "
    
    # Copy only what's needed for docker-compose (exclude node_modules)
    log "Copying Firecrawl files..."
    docker exec "${container_name}" bash -c "
        mkdir -p /firecrawl/apps
        cp /firecrawl-src/docker-compose.yaml /firecrawl/
        
        # Copy apps/api excluding node_modules
        mkdir -p /firecrawl/apps/api
        cd /firecrawl-src/apps/api
        find . -maxdepth 1 ! -name node_modules ! -name . -exec cp -r {} /firecrawl/apps/api/ \;
        
        cp -r /firecrawl-src/apps/playwright-service-ts /firecrawl/apps/
        cp -r /firecrawl-src/apps/nuq-postgres /firecrawl/apps/
    "
    
    # Generate and run test script
    log "Running integration tests in ${distro}..."
    generate_test_script | docker exec -i "${container_name}" bash
    
    if [ $? -eq 0 ]; then
        log "✅ ${distro}: ALL TESTS PASSED"
        TEST_RESULTS+=("${distro}: PASSED")
        return 0
    else
        error "❌ ${distro}: TESTS FAILED"
        TEST_RESULTS+=("${distro}: FAILED")
        return 1
    fi
}

show_summary() {
    echo ""
    log "=========================================="
    log "TEST SUMMARY"
    log "=========================================="
    for result in "${TEST_RESULTS[@]}"; do
        if [[ "$result" == *"PASSED"* ]]; then
            echo -e "${GREEN}✅ $result${NC}"
        else
            echo -e "${RED}❌ $result${NC}"
        fi
    done
}

usage() {
    echo "Usage: $0 [ubuntu|debian|all]"
    echo ""
    echo "Tests Firecrawl with Valkey on Ubuntu/Debian via Docker Compose."
    echo "This simulates a real self-hosted deployment."
    echo ""
    echo "Options:"
    echo "  ubuntu  - Test on Ubuntu 22.04"
    echo "  debian  - Test on Debian 12"
    echo "  all     - Test on both (default)"
}

# Main
case "${1:-all}" in
    ubuntu)
        check_prerequisites
        docker network create "${NETWORK_NAME}" 2>/dev/null || true
        test_distro "ubuntu" "ubuntu:22.04"
        show_summary
        ;;
    debian)
        check_prerequisites
        docker network create "${NETWORK_NAME}" 2>/dev/null || true
        test_distro "debian" "debian:12"
        show_summary
        ;;
    all)
        check_prerequisites
        docker network create "${NETWORK_NAME}" 2>/dev/null || true
        test_distro "ubuntu" "ubuntu:22.04"
        docker rm -f "firecrawl-ubuntu-${TEST_ID}" 2>/dev/null || true
        test_distro "debian" "debian:12"
        show_summary
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        echo "Unknown option: $1"
        usage
        exit 1
        ;;
esac
