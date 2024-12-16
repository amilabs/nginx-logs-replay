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
                    if (env.FILE_FILENAME.endsWith('.zip')) {
                        sh 'mv $FILE ${WORKSPACE}/nginx.zip'
                        sh 'unzip FILE -d ${WORKSPACE}'
                        sh 'ls -la'
                    } else {
                        sh 'mv FILE nginx.log'
                    }
                    sh """
                        node index.js \\
                            --filePath nginx.log \\
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