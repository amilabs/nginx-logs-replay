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
                    def fileName = 'FILE'
                    
                    if (params.FILE_FILENAME.endsWith('.gz')) {
                        sh "mv '${fileName}' 'TEMP_FILE.gz'"
                        sh "gunzip -c 'TEMP_FILE.gz' > '${fileName}'"
                    }
                    
                    sh """
                        node index.js \\
                            --filePath '${fileName}' \\
                            --ratio '${params.RATIO}' \\
                            --prefix '${params.PREFIX}' \\
                            --dateStats \\
                            ${params.CUSTOM_OPTIONS}
                    """
                }
            }
            post {
                success {
                    script {
                        // Проверяем, существует ли HTML файл
                        if (fileExists('time_diff_histogram.html')) {
                            // Архивируем HTML файл как артефакт
                            archiveArtifacts artifacts: 'time_diff_histogram.html', fingerprint: true
                            
                            // Публикуем HTML отчёт для просмотра в Jenkins
                            publishHTML([
                                allowMissing: false,
                                alwaysLinkToLastBuild: true,
                                keepAll: true,
                                reportDir: '.',
                                reportFiles: 'time_diff_histogram.html',
                                reportName: 'TimeDiff Histogram Report',
                                reportTitles: ''
                            ])
                            
                            echo 'TimeDiff histogram generated and published successfully'
                        } else {
                            echo 'TimeDiff histogram file not found - skipping artifact archiving and HTML report publishing'
                        }
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