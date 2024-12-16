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
                    if (params.FILE_FILENAME.endsWith('.zip')) {
                        sh 'mv $FILE ${WORKSPACE}/nginx.zip'
                        sh 'unzip ${WORKSPACE}/nginx.zip -d ${WORKSPACE}'
                    } else {
                        sh 'mv $FILE ${WORKSPACE}/nginx.log'
                    }
                    sh """
                        node index.js \\
                            --filePath ${WORKSPACE}/nginx.log \\
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