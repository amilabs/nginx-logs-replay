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
                    withFileParameter('FILE'){
                        sh """
                            node index.js \\
                                --filePath $FILE \\
                                --ratio $RATIO \\
                                --prefix $URL \\
                                $CUSTOM_OPTIONS
                        """
                    }
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