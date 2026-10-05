#!/usr/bin/env bash
# Build the image from this checkout and run it locally.
#   ./run-local.sh            build, start, wait until healthy, run smoke checks
#   ./run-local.sh logs       follow container logs
#   ./run-local.sh check      re-run the smoke checks against the running container
#   ./run-local.sh down       stop and remove the container
#   ./run-local.sh rebuild    same as default but ignores the build cache
# Set HOST_NET=1 to run with host networking (see compose.host.yaml).
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8080}"
BASE_URL="http://localhost:${PORT}"

# Fall back to sudo when the current user cannot reach the Docker socket.
if docker info >/dev/null 2>&1; then
    DOCKER="docker"
else
    DOCKER="sudo docker"
fi
COMPOSE="$DOCKER compose -f compose.yaml -f compose.dev.yaml"
if [ "${HOST_NET:-0}" = "1" ]; then
    COMPOSE="$COMPOSE -f compose.host.yaml"
fi

check() {
    local failed=0

    expect() {
        local name="$1" want="$2" got="$3"
        if [ "$got" = "$want" ]; then
            echo "  ok    $name ($got)"
        else
            echo "  FAIL  $name (expected $want, got $got)"
            failed=1
        fi
    }

    echo "Smoke checks against ${BASE_URL}:"
    expect "image is the local build" "stremio-docker:dev" \
        "$($COMPOSE ps --format '{{.Image}}' stremio 2>/dev/null | head -n 1)"
    expect "web player /" "200" \
        "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/")"
    expect "server API /settings" "200" \
        "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/settings")"
    expect "server API returns JSON" "application/json" \
        "$(curl -s -o /dev/null -w '%{content_type}' "${BASE_URL}/settings" | cut -d';' -f1)"
    expect "/localStorage.json (AUTO_SERVER_URL)" "200" \
        "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/localStorage.json")"
    expect "/server_url.env absent" "404" \
        "$(curl -s -o /dev/null -I -w '%{http_code}' "${BASE_URL}/server_url.env")"

    if [ "$failed" -ne 0 ]; then
        echo "Some checks failed. Inspect with: $0 logs"
        return 1
    fi
    echo "All checks passed. Open ${BASE_URL}/#/settings"
}

wait_ready() {
    echo "Waiting for the server to answer on ${BASE_URL} ..."
    for _ in $(seq 1 60); do
        if [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/settings" || true)" = "200" ]; then
            return 0
        fi
        sleep 2
    done
    echo "Server did not become ready within 120s. Last logs:"
    $COMPOSE logs --tail 40
    return 1
}

up() {
    # The ffmpeg stage compiles from source; the first build is slow.
    # --progress=plain prints a plain scrolling log instead of BuildKit's
    # redrawing status view, which only shows a few lines of the running step.
    $COMPOSE --progress=plain build "$@"
    $COMPOSE up -d --force-recreate
    wait_ready
    echo "Container startup log:"
    $COMPOSE logs --no-log-prefix --tail 30
    check
}

case "${1:-up}" in
    up)      up ;;
    rebuild) up --no-cache ;;
    check)   check ;;
    logs)    $COMPOSE logs -f ;;
    down)    $COMPOSE down ;;
    *)
        echo "Usage: $0 [up|rebuild|check|logs|down]"
        exit 1
        ;;
esac
