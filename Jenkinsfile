pipeline {
    agent { label "${params.AGENT}" }
    options {
        disableConcurrentBuilds()
    }
    stages {
        stage('Install Dependencies') {
            steps {
                sh 'npm i -g @amilabs/nginx-logs-replay'
            }
        }
        stage('Run nginx-logs-replay') {
            steps {
                script {
                    withFileParameter('FILE'){
                        sh """
                            nginx-replay \\
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
}