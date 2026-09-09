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
                        -e NO_COLOR=1 $EXTRA_ENV /app/src/discover.ts
                '''
            }
        }
        stage('Run') {
            steps {
                sh '''
                    docker run --rm --network=host -v "$WORK:/work" \
                        -e K6_WEB_DASHBOARD=true -e K6_WEB_DASHBOARD_EXPORT=/work/report.html \
                        "$IMAGE" \
                        -e PREFIX="$PREFIX" -e MODE="$MODE" -e RATIO="$RATIO" -e RPS="$RPS" \
                        -e DURATION="$DURATION" -e VUS="$VUS" -e QUERY_PARAMS="$QUERY_PARAMS" \
                        -e CACHE_BUSTER=cb -e DEBUG_TIME_UNIT=s -e NO_COLOR=1 $EXTRA_ENV \
                        /app/src/replay.ts
                '''
            }
        }
    }
    post {
        always {
            archiveArtifacts artifacts: 'work/summary.json, work/report.html, work/debug-schema.json', allowEmptyArchive: true
            script {
                if (fileExists('work/report.html')) {
                    publishHTML([
                        allowMissing: true,
                        alwaysLinkToLastBuild: true,
                        keepAll: true,
                        reportDir: 'work',
                        reportFiles: 'report.html',
                        reportName: 'k6 report',
                    ])
                }
            }
            sh 'docker rmi "$IMAGE" || true'
            cleanWs()
        }
    }
}
