// Jenkins job: scripts/nginx-logs-replay (DSL in devops: terraform/modules/jenkins/jobs/root/scripts/nginx-logs-replay.yaml).
// Keep the parameters block in sync with that DSL file.
pipeline {
    agent { label "${params.AGENT}" }
    options {
        disableConcurrentBuilds()
        timestamps()
    }
    parameters {
        choice(name: 'AGENT', choices: ['builder', 'docker-ds84', 'jen01', 's3-01', 's3-02'], description: 'Agent to generate the load from (needs docker)')
        stashedFile(name: 'FILE', description: 'nginx access log (plain or .gz). Empty = examples/access.log smoke run')
        string(name: 'PREFIX', defaultValue: 'https://ethp.amilabs.net', description: 'Target base URL')
        string(name: 'LOAD', defaultValue: 'x1', description: 'x1 = replay the log at its own pace, x2 = twice as fast, 0.5 = half; or "50rps for 5m" = fixed rate from the same requests (default duration 60s)')
        string(name: 'VUS', defaultValue: '50', description: 'max concurrency (replay) / pre-allocated VUs (rate)')
        booleanParam(name: 'DISCOVER', defaultValue: true, description: 'Run discover.ts first to build the debug schema (per-component metrics)')
        string(name: 'EXTRA_ENV', defaultValue: '-e CACHE_BUSTER=cb -e QUERY_PARAMS=debugId=clickhouse -e DEBUG_TIME_UNIT=s', description: 'Extra k6 -e options (QUERY_PARAMS=debugId=... enables the debug block on Ethplorer-style APIs, whose times are in seconds)')
    }
    environment {
        IMAGE = "nginx-logs-replay:${env.BUILD_NUMBER}"
        WORK = "${env.WORKSPACE}/work"
    }
    stages {
        stage('Parse LOAD') {
            steps {
                script {
                    // "x2" / "2" -> replay at ratio 2; "50rps" / "50rps for 5m" -> fixed rate
                    def spec = params.LOAD.trim().toLowerCase().replaceAll(/\s+/, ' ')
                    if (spec.contains('rps')) {
                        def parts = spec.split('rps', 2)
                        def rest = parts[1].trim().replaceFirst(/^for\s*/, '')
                        env.MODE = 'rate'
                        env.RPS = parts[0].trim()
                        env.DURATION = rest ?: '60s'
                        env.RATIO = '1'
                    } else {
                        env.MODE = 'replay'
                        env.RATIO = spec.startsWith('x') ? spec.substring(1) : spec
                        env.RPS = '10'
                        env.DURATION = '60s'
                    }
                    if (!env.RATIO.isNumber() || !env.RPS.isNumber()) {
                        error("LOAD must look like x2 (replay at 2x) or 50rps for 5m (fixed rate), got: ${params.LOAD}")
                    }
                    echo "load: MODE=${env.MODE} RATIO=${env.RATIO} RPS=${env.RPS} DURATION=${env.DURATION}"
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
            when { expression { params.DISCOVER } }
            steps {
                sh '''
                    docker run --rm --network=host -v "$WORK:/work" "$IMAGE" \
                        -e PREFIX="$PREFIX" -e NO_COLOR=1 $EXTRA_ENV /app/src/discover.ts
                '''
            }
        }
        stage('Replay') {
            steps {
                sh '''
                    docker run --rm --network=host -v "$WORK:/work" \
                        -e K6_WEB_DASHBOARD=true -e K6_WEB_DASHBOARD_EXPORT=/work/report.html \
                        "$IMAGE" \
                        -e PREFIX="$PREFIX" -e MODE="$MODE" -e RATIO="$RATIO" -e RPS="$RPS" \
                        -e DURATION="$DURATION" -e VUS="$VUS" -e NO_COLOR=1 $EXTRA_ENV \
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
