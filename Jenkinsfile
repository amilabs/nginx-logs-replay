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
                    sh "echo $FILE_FILENAME"
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