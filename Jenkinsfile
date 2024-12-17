pipeline {
    agent { label "${params.AGENT}" }
    options {
        disableConcurrentBuilds()
    }
    stages {
        stage('Install Dependencies') {
            steps {
                sh 'npm i'
            }
        }
        stage('Run nginx-logs-replay') {
            steps {
                script {
                    unstash 'FILE'
                    if (env.FILE_FILENAME.endsWith('.gz')) {
                        sh "mv FILE TEMP_FILE.gz"
                        sh 'gunzip -c "TEMP_FILE.gz" > FILE'
                    }
                    sh """
                        node index.js \\
                            --filePath FILE \\
                            --ratio $RATIO \\
                            --prefix $PREFIX \\
                            $CUSTOM_OPTIONS
                    """
                }
            }
        }
    }
    post {
        always {
            cleanWs()
        }
    }
}