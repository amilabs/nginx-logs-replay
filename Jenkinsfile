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
                        sh 'mv $FILE ${WORKSPACE}/nginx.log'
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
    }
    post {
        always {
            cleanWs()
        }
    }
}