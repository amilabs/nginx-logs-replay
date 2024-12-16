pipeline {
    agent { label "${params.AGENT}" }
    options {
        disableConcurrentBuilds()
    }
    stages {
        stage('Install Dependencies') {
            steps {
                sh 'npm install'
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
}