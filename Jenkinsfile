pipeline {
    agent { label "${params.AGENT}" }
    options {
        disableConcurrentBuilds()
        timestamps()
    }
    parameters {
        choice(name: 'AGENT', choices: ['agent1', 'agent2', 'agent3'], description: 'Agent to run the load from')
        file(name: 'FILE', description: 'nginx access log (plain or .gz)')
        string(name: 'PREFIX', defaultValue: 'https://api.example.com', description: 'Target base URL')
        choice(name: 'MODE', choices: ['replay', 'rate'], description: 'replay = log timeline, rate = fixed RPS')
        string(name: 'RATIO', defaultValue: '1', description: 'replay: speed multiplier')
        string(name: 'RPS', defaultValue: '10', description: 'rate: requests per second')
        string(name: 'DURATION', defaultValue: '60s', description: 'rate: duration')
        string(name: 'VUS', defaultValue: '50', description: 'max concurrency (replay) / pre-allocated VUs (rate)')
        booleanParam(name: 'DISCOVER', defaultValue: true, description: 'Run discover.ts first to build the debug schema')
        string(name: 'EXTRA_ENV', defaultValue: '', description: 'Extra k6 -e options, e.g. "-e CACHE_BUSTER=cb -e QUERY_PARAMS=apiKey=x"')
    }
    environment {
        IMAGE = "nginx-logs-replay:${env.BUILD_NUMBER}"
        WORK = "${env.WORKSPACE}/work"
    }
    stages {
        stage('Build image') {
            steps {
                sh 'docker build -t "$IMAGE" .'
            }
        }
        stage('Prepare log') {
            steps {
                sh 'rm -rf "$WORK" && mkdir -p "$WORK"'
                unstash 'FILE'
                script {
                    if (env.FILE_FILENAME?.endsWith('.gz')) {
                        sh 'gunzip -c FILE > "$WORK/access.log"'
                    } else {
                        sh 'mv FILE "$WORK/access.log"'
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
