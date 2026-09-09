// Shared pipeline for two Jenkins jobs (parameters are defined in the devops
// job DSL, terraform/modules/jenkins/jobs/root/scripts/):
//   nginx-logs-replay  — params AGENT, FILE, PREFIX, RATIO, VUS, QUERY_PARAMS, EXTRA_ENV
//   nginx-logs-rate    — params AGENT, FILE, PREFIX, RPS, DURATION, VUS, QUERY_PARAMS, EXTRA_ENV
// The mode is derived from which parameters the job has (RPS => rate).
// Always on: a per-request cache buster (CACHE_BUSTER=cb) and DEBUG_TIME_UNIT=s
// (Ethplorer-style debug blocks report seconds).
pipeline {
    agent { label "${params.AGENT ?: 'builder'}" }
    options {
        disableConcurrentBuilds()
        timestamps()
    }
    environment {
        IMAGE = "nginx-logs-replay:${env.BUILD_NUMBER}"
        WORK = "${env.WORKSPACE}/work"
        CONTAINER = "nginx-logs-replay-${env.JOB_BASE_NAME}-${env.BUILD_NUMBER}"
    }
    stages {
        stage('Resolve mode') {
            steps {
                script {
                    def rate = params.containsKey('RPS')
                    env.MODE = rate ? 'rate' : 'replay'
                    env.RATIO = rate ? '1' : (params.RATIO ?: '1')
                    env.RPS = rate ? params.RPS : '10'
                    env.DURATION = rate ? (params.DURATION ?: '60s') : '60s'
                    env.VUS = params.VUS ?: '50'
                    env.PREFIX = params.PREFIX
                    env.QUERY_PARAMS = params.QUERY_PARAMS ?: ''
                    env.EXTRA_ENV = params.EXTRA_ENV ?: ''
                    if (!env.PREFIX) error('PREFIX is required')
                    echo "mode=${env.MODE} ratio=${env.RATIO} rps=${env.RPS} duration=${env.DURATION} vus=${env.VUS} target=${env.PREFIX} query=${env.QUERY_PARAMS}"
                }
            }
        }
        stage('Build image') {
            steps {
                sh 'docker build -t "$IMAGE" .'
            }
        }
        stage('Prepare log') {
            steps {
                sh 'rm -rf "$WORK" && mkdir -p "$WORK" && chmod 777 "$WORK"'
                script {
                    def uploaded = false
                    try {
                        unstash 'FILE'
                        uploaded = fileExists('FILE') && env.FILE_FILENAME
                    } catch (ignored) {
                        echo 'No FILE parameter uploaded'
                    }
                    if (uploaded) {
                        if (env.FILE_FILENAME.endsWith('.gz')) {
                            sh 'gunzip -c FILE > "$WORK/access.log"'
                        } else {
                            sh 'mv FILE "$WORK/access.log"'
                        }
                    } else {
                        echo 'Using examples/access.log (smoke run)'
                        sh 'cp examples/access.log "$WORK/access.log"'
                    }
                }
                sh 'wc -l "$WORK/access.log"'
            }
        }
        stage('Discover debug schema') {
            steps {
                sh '''
                    docker run --rm --network=host -v "$WORK:/work" "$IMAGE" \
                        -e PREFIX="$PREFIX" -e QUERY_PARAMS="$QUERY_PARAMS" -e CACHE_BUSTER=cb -e DEBUG_TIME_UNIT=s \
                        -e DISCOVER_N=20 -e NO_COLOR=1 $EXTRA_ENV /app/src/discover.ts
                '''
            }
        }
        stage('Run') {
            steps {
                // Detached container so that an aborted build can still stop k6
                // gracefully (SIGTERM => k6 writes the summary) in the post block.
                sh '''
                    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
                    docker run -d --name "$CONTAINER" --network=host -v "$WORK:/work" \
                        -e K6_WEB_DASHBOARD=true -e K6_WEB_DASHBOARD_EXPORT=/work/k6-dashboard.html -e K6_WEB_DASHBOARD_PERIOD=1s \
                        "$IMAGE" \
                        -e PREFIX="$PREFIX" -e MODE="$MODE" -e RATIO="$RATIO" -e RPS="$RPS" \
                        -e DURATION="$DURATION" -e VUS="$VUS" -e QUERY_PARAMS="$QUERY_PARAMS" \
                        -e CACHE_BUSTER=cb -e DEBUG_TIME_UNIT=s -e DASHBOARD_HREF=k6-dashboard.html -e NO_COLOR=1 $EXTRA_ENV \
                        /app/src/replay.ts >/dev/null
                    docker logs -f "$CONTAINER"
                    exit "$(docker wait "$CONTAINER")"
                '''
            }
        }
    }
    post {
        always {
            // On abort the container is still running: stop it gracefully so the
            // summary (console, summary.json, summary.html, k6-dashboard.html) is written.
            sh '''
                if [ -n "$(docker ps -q --filter "name=^$CONTAINER$")" ]; then
                    echo "Build interrupted: stopping k6 gracefully (up to 60s) to get the report"
                    docker stop -t 60 "$CONTAINER" >/dev/null || true
                    docker logs --tail 150 "$CONTAINER" 2>&1 || true
                fi
                docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
            '''
            archiveArtifacts artifacts: 'work/summary.json, work/summary.html, work/k6-dashboard.html, work/debug-schema.json', allowEmptyArchive: true
            script {
                if (fileExists('work/summary.html')) {
                    publishHTML([
                        allowMissing: true,
                        alwaysLinkToLastBuild: true,
                        keepAll: true,
                        reportDir: 'work',
                        reportFiles: 'summary.html,k6-dashboard.html',
                        reportTitles: 'Summary,k6 dashboard (time series)',
                        reportName: 'Replay report',
                    ])
                }
            }
            sh 'docker rmi "$IMAGE" || true'
            cleanWs()
        }
    }
}
