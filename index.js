#!/usr/bin/env node
const Moment = require('moment');
const fs = require('fs');
const NginxParser = require('nginxparser');
const axios = require('axios').default;
const https = require('https');
const Winston = require('winston');
const {program} = require('commander');
const rl = require("readline");
const Stats = require('fast-stats').Stats;
const _ = require('lodash');
const path = require('path');
program.version(process.env.npm_package_version);
const zeroPad = (num, places) => String(num).padStart(places, '0')
const defaultFormat = '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"';
const defaultFormatTime = 'DD/MMM/YYYY:HH:mm:ss';

program
    .requiredOption('-p, --prefix <url>', 'url for sending requests')
    .option('-f, --filePath <path>', 'path of the nginx logs file')
    .option('-r, --ratio <number>', 'acceleration / deceleration rate of sending requests, eg: 2, 0.5', '1')
    .option('--format <string>', 'format of the nginx log', defaultFormat)
    .option('--formatTime <string>', 'format of the nginx time', defaultFormatTime)
    .option('--startTimestamp <number>', 'start replaying logs from this timestamp', '0')
    .option('-d --debug', 'show debug messages in console', false)
    .option('-l, --logFile <path>', 'save results to the logs file', '')
    .option('-t, --timeout <int>', 'timeout fo the requests')
    .option('--username <string>', 'username for basic auth')
    .option('--password <string>', 'password  for basic auth')
    .option('--scaleMode', 'experimental mode for the changing requests order', false)
    .option('--generatorMode', 'node without reading nginx logs but generating it automatically', false)
    .option('--generatorModeRPS <number>', 'mode without reading nginx logs but generating it automatically', 1)
    .option('--generatorModeAlphabet <string>', 'alphabet for the generator mode', "ABC")
    .option('--generatorModeMinLength <number>', 'generator mode min string length', 1)
    .option('--generatorModeMaxLength <number>', 'generator mode max string length', 1)
    .option('--generatorModeNumberOfRequests <number>', 'generator mode number of requests', 1)
    .option('--responseTimeLimit <number>', 'calculating only responses with response time which greater than this option', 0)
    .option('--skipSleep', 'remove pauses between requests. Attention: will ddos your server', false)
    .option('--skipSsl', 'skip ssl errors', false)
    .option('--showSearchDebug', 'show search debug', false)
    .option('--showCounters', 'show counters of responses', false)
    .option('--datesFormat <string>', 'format of dates to display in logs (regarding Moment.js parsing format)', "DD-MM-YYYY:HH:mm:ss")
    .option('-s, --stats', 'show stats of the requests', false)
    .option('--deleteQueryStats [strings...]', 'delete some query for calculating stats, eg: "page limit size"', [])
    .option('--statsOnlyPath', 'keep only endpoints for showing stats', false)
    .option('--filterOnly [strings...]', 'filter logs for replaying, eg: "/test data .php"', [])
    .option('--filterSkip [strings...]', 'skip logs for replaying, eg: "/test data .php"', [])
    .option('--customQueryParams [strings...]', 'additional query params fro requests, eg: "test=true size=3"', [])
    .option('--dateStats', 'calculate date stats', false)
    .option('--hideStatsLimit <int>', 'limit number of stats', '0');

program.parse(process.argv);
const args = program.opts();
Object.entries(args).forEach(arg => {
    if (typeof arg[1] === "string" && arg[1].startsWith('=')) args[arg[0]] = arg[1].replace('=', '');
})

const debugLogger = Winston.createLogger({
    format: Winston.format.simple(),
    silent: !args.debug,
    transports: [
        new Winston.transports.Console(),
    ]
});

const mainLogger = Winston.createLogger({
    format: Winston.format.simple(),
    transports: [
        new Winston.transports.Console(),
    ]
});

let resultLoggerTransports = [
    new Winston.transports.Console({
        level: 'info',
        format: Winston.format.combine(
            Winston.format.colorize(),
            Winston.format.printf(
                (info) => {
                    return `${info.message}`;
                })
        )
    }),
];
if (args.logFile !== '') {
    resultLoggerTransports.push(new Winston.transports.File({
        filename: args.logFile,
        level: 'info',
        format: Winston.format.combine(
            Winston.format.colorize(),
            Winston.format.printf(
                (info) => {
                    return `${info.message}`;
                })
        )
    }));
}

const resultLogger = Winston.createLogger({
    format: Winston.format.simple(),
    transports: resultLoggerTransports,
});

const dataArray = [];
let numberOfSuccessfulEvents = 0;
let numberOfFailedEvents = 0;
let numberOfNotEmptyResponses = 0;
let numberOfSkippedEventsBecauseOfResponseTimeLimit = 0;
let numberOfNotSkippedNotEmptyEvents = 0;
let totalResponseTime = 0;
let startTime = 0;
let finishTime = 0;
let totalSleepTime = 0;
let numStats = new Stats();
const dateStats = {
    timestampFirst: new Stats(),
    timestamp: new Stats(),
    timestampDiff: new Stats(),
    timeDiff: new Stats(),
    timeDiffHistorical: new Stats(),
    empty: 0,
    numberOfRequestsWithLimitGreaterThanDefault: 0,
    numberOfRequestsWithNumberOfRecordsLessThanPageSize: 0,
    numberOfRequestsWithDataOlderThanAHalfYear: 0
}

const deleteQuery = args.deleteQueryStats;
const stats = {};

const statsMetrics = {};
if (!args.generatorMode){
    fs.access(args.filePath, fs.F_OK, (err) => {
        if (err) {
            mainLogger.error(`Cannot find file ${args.filePath}`);
            process.exit(1);
        }
    });
}

if (args.logFile) {
    if (args.logFile === args.filePath) {
        mainLogger.error(`logFile can not be equal to filePath`);
        process.exit(1);
    }
    if (fs.existsSync(args.logFile)) fs.unlinkSync(args.logFile);
}

const secondsRepeats = {};
let currentTimestamp = 0;

//Display results info in case of interruption
if (process.platform === "win32") {
    rl.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.on("SIGINT", () => {
        process.emit("SIGINT");
    });
}

process.on("SIGINT", () => {
    if (currentTimestamp>0) mainLogger.info(`Interrupted at timestamp ${currentTimestamp}`);
    generateReport();
    process.exit();
});

args.startTimestamp = args.startTimestamp*1000;
const startProcessTime = new Date();
const parser = new NginxParser(args.format);

function parseRow(row){
    const timestamp = Moment(row.time_local, args.formatTime).unix() * 1000;
    let isFilterSkip = false;
    args.filterSkip.forEach(filter => {
        if (row.request.includes(filter)) isFilterSkip = true;
    });
    let isFilterOnly = args.filterOnly.length === 0;
    args.filterOnly.forEach(filter => {
        if (row.request.includes(filter)) isFilterOnly = true;
    });
    if (timestamp>args.startTimestamp && isFilterOnly && !isFilterSkip){
        dataArray.push({
            agent: row.http_user_agent,
            status: row.status,
            req: row.request,
            timestamp
        });
        if (args.scaleMode) {
            secondsRepeats[timestamp] ? secondsRepeats[timestamp] += 1 : secondsRepeats[timestamp] = 1;
        }
    }
}

async function replay(){
    startTime = +new Date();
    if (dataArray.length===0) mainLogger.info(`No logs for the replaying`);
    for (let i = 0; i < dataArray.length; i++) {
        const now = +new Date();
        finishTime = now;
        let requestMethod = dataArray[i].req.split(" ")[0];
        let requestUrl;
        if (args.customQueryParams.length!==0){
            requestUrl = new URL(args.prefix + dataArray[i].req.split(" ")[1]);
            args.customQueryParams.forEach(queryParam=>{
                requestUrl.searchParams.delete(queryParam.split('=')[0]);
                requestUrl.searchParams.append(queryParam.split('=')[0],queryParam.split('=')[1]);
            });
            requestUrl = requestUrl.toString().replace(args.prefix, "");
        }else{
            requestUrl = dataArray[i].req.split(" ")[1];
        }
        debugLogger.info(`Sending ${requestMethod} request to ${requestUrl} at ${now}`);
        
        if (args.stats) {
            let statsUrl = new URL(args.prefix + requestUrl);
            if (args.statsOnlyPath) {
                statsUrl = statsUrl.pathname;
            } else {
                deleteQuery.forEach(query => statsUrl.searchParams.delete(query));
                statsUrl = statsUrl.toString().replace(args.prefix, "");
            }
            stats[statsUrl] ? stats[statsUrl] += 1 : stats[statsUrl] = 1;
        }
        currentTimestamp=dataArray[i].timestamp;
        sendRequest(requestMethod, requestUrl, now, dataArray[i].agent, dataArray[i].status, dataArray[i].timestamp);
        if (!args.skipSleep && dataArray[i].timestamp !== dataArray[dataArray.length - 1].timestamp) {
            if (args.scaleMode) {
                const timeToSleep = (Number((1000 / secondsRepeats[dataArray[i].timestamp]).toFixed(0)) +
                    (dataArray[i].timestamp === dataArray[i + 1].timestamp ? 0 : (dataArray[i + 1].timestamp - dataArray[i].timestamp - 1000))) / args.ratio;
                totalSleepTime += timeToSleep;
                debugLogger.info(`Sleeping ${timeToSleep} ms`);
                await sleep(timeToSleep);
            } else {
                if (dataArray[i].timestamp !== dataArray[i + 1].timestamp) {
                    const timeToSleep = ((dataArray[i + 1].timestamp - dataArray[i].timestamp) / args.ratio);
                    debugLogger.info(`Sleeping ${timeToSleep} ms`);
                    totalSleepTime += timeToSleep;
                    await sleep(timeToSleep);
                }
            }
        }
    }

}
if (args.generatorMode){
    const startTimestamp = +new Date();
    const alphabet = args.generatorModeAlphabet.split("")
    for (let i = 0; i < args.generatorModeNumberOfRequests; i++) {
        let randomString = '';
        for (let i = 0; i < _.random(Number(args.generatorModeMinLength), Number(args.generatorModeMaxLength)); i++) {
            randomString+=alphabet[Math.floor(Math.random()*alphabet.length)];
        }
        dataArray.push({
            agent: "generator",
            status: "200",
            req: `GET ${randomString}`,
            timestamp: startTimestamp + 1000*i/args.generatorModeRPS
        });
    }
    (async () => {
        await replay();
    })();

}else{
    parser.read(args.filePath, function (row) {
        parseRow(row)
    }, async function (err) {
        if (err) throw err;
        await replay();
    });
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function sendRequest(method, url, sendTime, agent, originalStatus, timestamp) {
    const httpsAgent = new https.Agent({
        rejectUnauthorized: !args.skipSsl
    });
    let config = {httpsAgent, method, url: args.prefix + url, auth:{}};
    if (args.username) config.auth.username = args.username;
    if (args.password) config.auth.password = args.password;
    if (args.timeout) config.timeout = parseInt(args.timeout);
    if (agent) config.headers = {'User-Agent': agent};
    axios(config)
        .then(function (response) {
            debugLogger.info(`Response for ${url} with status code ${response.status} done with ${+new Date() - sendTime} ms`);
            parseResponse(response, method, url, sendTime, agent, originalStatus, timestamp);
        })
        .catch(function (error) {
            if (!error.response) {
                mainLogger.error(`Invalid request to ${url} : ${error}`)
                numberOfFailedEvents += 1;
            } else {
                parseResponse(error.response, method, url, sendTime, agent, originalStatus, timestamp);
            }
        }).then(function () {
        if (numberOfFailedEvents + numberOfSuccessfulEvents === dataArray.length) {
            generateReport();
        }
    });
}

function parseResponse(response, method, url, sendTime, agent, originalStatus, timestamp){
    const responseTime = +new Date() - sendTime;
        if (originalStatus !== response.status.toString()) {
            debugLogger.info(`Response for ${url} has different status code: ${response.status} and ${originalStatus}`);
            numberOfFailedEvents += 1;
        } else {
            numberOfSuccessfulEvents += 1;
        }
        if (response.data && response.data.results && response.data.results.length>0) numberOfNotEmptyResponses+=1;
        totalResponseTime += responseTime;
        numStats.push(responseTime);
        if (response.data){
            if (args.dateStats){
                let limit = 10;
                const urlObj = new URL(args.prefix + url);
                const pathname = urlObj.pathname;
                
                if (pathname.includes('/getAddressTransactions') || 
                    pathname.includes('/getTokenHistory') || 
                    pathname.includes('/getAddressHistory')) {
                    const limitParam = urlObj.searchParams.get('limit');
                    if (limitParam) {
                        limit = parseInt(limitParam);
                    }
                }
                
                else if (pathname.includes('/service/service.php')) {
                    const pageParam = urlObj.searchParams.get('page');
                    
                    if (pageParam) {
                        const decodedPage = decodeURIComponent(pageParam);
                        const pageSizeMatch = decodedPage.match(/pageSize[=%](\d+)/);
                        if (pageSizeMatch) {
                            limit = parseInt(pageSizeMatch[1]);
                        }
                    }
                }
                if (limit>10){
                   dateStats.numberOfRequestsWithLimitGreaterThanDefault++;
                }
                if (response.status.toString()==="200"){

                    let lastTimestamp;
                    let firstTimestamp;
                    if (url.includes("/getAddressTransactions")){
                        if (response.data.length>0){
                            lastTimestamp = response.data[response.data.length-1].timestamp;
                            firstTimestamp = response.data[0].timestamp;
                            if (response.data.length<limit){
                                dateStats.numberOfRequestsWithNumberOfRecordsLessThanPageSize++;
                                if (lastTimestamp < (timestamp/1000-60*60*24*30*6)){
                                    dateStats.numberOfRequestsWithDataOlderThanAHalfYear++;
                                }
                            }
                        }else{
                            dateStats.empty+=1;
                        }
                    }else if (url.includes("/getTokenHistory") || url.includes("/getAddressHistory")) {
                        if (response.data.operations.length>0){
                            lastTimestamp = response.data.operations[response.data.operations.length-1].timestamp;
                            firstTimestamp = response.data.operations[0].timestamp;
                            if (response.data.operations.length<limit){
                                dateStats.numberOfRequestsWithNumberOfRecordsLessThanPageSize++;
                                if (lastTimestamp < (timestamp/1000-60*60*24*30*6)){
                                    dateStats.numberOfRequestsWithDataOlderThanAHalfYear++;
                                }
                            }
                        }
                    }else if(url.includes("/service/service.php?data=")){
                        if (response.data.transfers.length>0){
                            lastTimestamp = response.data.transfers[response.data.transfers.length-1].timestamp;
                            firstTimestamp = response.data.transfers[0].timestamp;
                            if (response.data.transfers.length<limit){
                                dateStats.numberOfRequestsWithNumberOfRecordsLessThanPageSize++;
                                if (lastTimestamp < (timestamp/1000-60*60*24*30*6)){
                                    dateStats.numberOfRequestsWithDataOlderThanAHalfYear++;
                                }
                            }
                        }else{
                            dateStats.empty+=1;
                        }
                    }
                    if (firstTimestamp){
                            dateStats.timestamp.push(lastTimestamp);
                            dateStats.timestampFirst.push(firstTimestamp);
                            dateStats.timestampDiff.push(firstTimestamp-lastTimestamp);
                            dateStats.timeDiffHistorical.push(timestamp/1000 - lastTimestamp);
                            dateStats.timeDiff.push((+new Date()/1000) - lastTimestamp);
                    }
                }
            }
            if (response.data.debug){
                function parseObject(object, name){
                    function setField(name, field, value, type){
                        const distName = name===undefined?field:name+"."+field;
                        if (statsMetrics[distName]===undefined){
                            statsMetrics[distName]={}
                        }
                        if (statsMetrics[distName][type]===undefined){
                            statsMetrics[distName][type]=new Stats();
                        }
                        statsMetrics[distName][type].push(value);
                    }
                    for (const [field, fieldValue] of Object.entries(object)){
                        if (fieldValue){
                            if (typeof fieldValue==="object"){
                                if (_.has(fieldValue, "queries") || _.has(fieldValue, "num") || _.has(fieldValue, "time")){
                                    if (_.has(fieldValue, "num")) setField(name, field, fieldValue["num"], "num")
                                    if (_.has(fieldValue, "time")) setField(name, field, fieldValue["time"], "time")
                                    if (_.has(fieldValue, "queries")){
                                        for (const [subField, subValue] of Object.entries(fieldValue["queries"])){
                                            setField(name, field+"."+subField, subValue, "time");
                                        }
                                    }
                                } else if(_.has(fieldValue, "usage")){
                                    setField(name, field, fieldValue["usage"], "usage")
                                    setField(name, field, fieldValue["peak"], "peak")
                                }else{
                                    parseObject(fieldValue, name===undefined?field:name+"."+field);
                                }

                            }else if (typeof fieldValue === 'number'){
                                setField(name, field, fieldValue, "time");
                            }
                        }
                    }
                }
                parseObject(response.data.debug)
            }
        }
        if (responseTime>Number(args.responseTimeLimit)*1000){
            if (response.data && response.data.results && response.data.results.length>0) numberOfNotSkippedNotEmptyEvents+=1;
            resultLogger.info(`${args.showCounters?`${zeroPad(numberOfFailedEvents+numberOfSuccessfulEvents, dataArray.length.toString().length)}/${dataArray.length}     `:""}${response.status}     ${originalStatus}     ${Moment.unix(timestamp / 1000).format(args.datesFormat)}     ${Moment.unix(sendTime / 1000).format(args.datesFormat)}     ${(responseTime / 1000).toFixed(2)}${(args.showSearchDebug && response.data.debug && response.data.debug.search && response.data.debug.search.search)?`     [${response.data.debug.search.search.length}]     {${zeroPad(response.data.results.length,2)}}     ${response.data.debug.search.search}`:''}     ${decodeURI(url)}     ${url}`)
        }else{
            numberOfSkippedEventsBecauseOfResponseTimeLimit+=1;
        }
        if (response.data.debug) debugLogger.info(JSON.stringify(response.data.debug));

}

function getPercentile(stat, toSeconds=false, fixed=3){
    const percentiles = [1,5,25,50,75,95,99];
    let percentilesObject = {};
    percentiles.forEach(percentile=>{
        percentilesObject[percentile] = (stat.percentile(percentile)/(toSeconds?1000:1)).toFixed(fixed)
    });
    return percentilesObject;
}

function getPercentileTimestamp(stat, toDate=true){
    const percentiles = [1,5,25,50,75,95,99];
    let percentilesObject = {};
    percentiles.forEach(percentile=>{
        if (toDate){
            percentilesObject[percentile] = Moment.unix(stat.percentile(percentile)).format(args.datesFormat);
        }else{
            percentilesObject[percentile] = (stat.percentile(percentile));
        }
    });
    return percentilesObject;
}

function getPercentileDays(stat, percentiles=[1,5,25,50,75,95,99]){
    let percentilesObject = {};
    percentiles.forEach(percentile=>{
        percentilesObject[percentile] = (stat.percentile(percentile)/(60*60*24)).toFixed(2);
    });
    return percentilesObject;
}

function getResponseTime(stat, toSeconds=false, toFixed=3){
    return {minimum:(stat.range()[0]/(toSeconds?1000:1)).toFixed(toFixed),
        maximum:(stat.range()[1]/(toSeconds?1000:1)).toFixed(toFixed),
        average: (stat.amean()/(toSeconds?1000:1)).toFixed(3),
        total: (stat.sum/(toSeconds?1000:1)).toFixed(toFixed),
        number: stat.length};
}

function generateReport(){
    mainLogger.info('___________________________________________________________________________');
    mainLogger.info(`Host: ${args.prefix}. Start time: ${startProcessTime.toISOString()}. Finish time: ${(new Date()).toISOString()}. Options: ${args.customQueryParams}`);
    mainLogger.info(`Total number of requests: ${numberOfSuccessfulEvents+numberOfFailedEvents}. Number of the failed requests: ${numberOfFailedEvents}. Percent of the successful requests: ${(100 * numberOfSuccessfulEvents / (numberOfSuccessfulEvents+numberOfFailedEvents)).toFixed(2)}%.`);
    mainLogger.info(`Number of not empty responses: ${numberOfNotEmptyResponses}. Percent of not empty responses: ${(100 * numberOfNotEmptyResponses / (numberOfSuccessfulEvents+numberOfFailedEvents)).toFixed(2)}%.`);
    if (Number(args.responseTimeLimit)>0)mainLogger.info(`Number of skipped responses because of response time limit: ${numberOfSkippedEventsBecauseOfResponseTimeLimit}. Percent of skipped responses: ${(100 * numberOfSkippedEventsBecauseOfResponseTimeLimit / (numberOfSuccessfulEvents+numberOfFailedEvents)).toFixed(2)}%. Number of not empty not skipped responses: ${numberOfNotSkippedNotEmptyEvents}. Percent of not empty not skipped responses: ${(100 * numberOfNotSkippedNotEmptyEvents / (numberOfSkippedEventsBecauseOfResponseTimeLimit)).toFixed(2)}%.\``);
    mainLogger.info(`Response time: ${JSON.stringify(getResponseTime(numStats,true))}`);
    mainLogger.info(`Percentile: ${JSON.stringify(getPercentile(numStats, true))}`);
    Object.keys(statsMetrics).forEach(field=>{
        if (statsMetrics[field]["time"] && statsMetrics[field]["time"].length!==statsMetrics[field]["time"].zeroes){
            mainLogger.info(`${field} time: ${JSON.stringify(getResponseTime(statsMetrics[field]["time"], false))}`);
            mainLogger.info(`${field} time percentile: ${JSON.stringify(getPercentile(statsMetrics[field]["time"]))}`);
        }
        if (statsMetrics[field]["num"] && statsMetrics[field]["num"].length>0 && statsMetrics[field]["num"].length!==statsMetrics[field]["num"].zeroes){
            mainLogger.info(`${field} number: ${JSON.stringify(getResponseTime(statsMetrics[field]["num"], false,0))}`);
        }
    });
    mainLogger.info(`Total requests time: ${(finishTime - startTime) / 1000} seconds. Total sleep time: ${(totalSleepTime / 1000).toFixed(2)} seconds.`);
    mainLogger.info(`Original time: ${(dataArray[dataArray.length - 1].timestamp - dataArray[0].timestamp) / 1000} seconds. Original rps: ${(1000 * dataArray.length / (dataArray[dataArray.length - 1].timestamp - dataArray[0].timestamp)).toFixed(4)}. Replay rps: ${((numberOfSuccessfulEvents+numberOfFailedEvents) * 1000 / (finishTime - startTime)).toFixed(4)}. Ratio: ${args.ratio}.`);
    if (args.dateStats && dateStats.timestamp.length>0){
        mainLogger.info(`First timestamps: ${JSON.stringify(getPercentileTimestamp(dateStats.timestampFirst))}`);
        mainLogger.info(`Last timestamps: ${JSON.stringify(getPercentileTimestamp(dateStats.timestamp))}`);
        mainLogger.info(`Diff between first and last timestamps: ${JSON.stringify(getPercentileDays(dateStats.timestampDiff, [1,5,20,25,30,35,40,45,50,55,60,65,70,75,80,95,99]))}`);
        mainLogger.info(`Days diff current: ${JSON.stringify(getPercentileDays(dateStats.timeDiff, [1,5,20,25,30,35,40,45,50,55,60,65,70,75,80,95,99]))}`);
        mainLogger.info(`Days diff historical: ${JSON.stringify(getPercentileDays(dateStats.timeDiffHistorical, [1,5,20,25,30,35,40,45,50,55,60,65,70,75,80,95,99]))}`);
        mainLogger.info(`Number of empty responses for date stats: ${dateStats.empty}`);
        mainLogger.info(`Number of requests with limit greater than default (10): ${dateStats.numberOfRequestsWithLimitGreaterThanDefault}`);
        mainLogger.info(`Number of requests with limit/pageSize greater than default (10): ${dateStats.numberOfRequestsWithLimitGreaterThanDefault}. Percent: ${(100*dateStats.numberOfRequestsWithLimitGreaterThanDefault/(numberOfSuccessfulEvents+numberOfFailedEvents)).toFixed(2)}%.`);
        mainLogger.info(`Number of requests with number of records less than pageSize/limit: ${dateStats.numberOfRequestsWithNumberOfRecordsLessThanPageSize} of ${dateStats.timestampFirst.length} requests with data. Percent: ${(100*dateStats.numberOfRequestsWithNumberOfRecordsLessThanPageSize/dateStats.timestampFirst.length).toFixed(2)}%.`);
        mainLogger.info(`Number of requests with data older than a half year: ${dateStats.numberOfRequestsWithDataOlderThanAHalfYear} of ${dateStats.numberOfRequestsWithNumberOfRecordsLessThanPageSize} requests with number of records less than pageSize/limit. Percent: ${(100*dateStats.numberOfRequestsWithDataOlderThanAHalfYear/dateStats.numberOfRequestsWithNumberOfRecordsLessThanPageSize).toFixed(2)}%.`);
        // Создаем интерактивную диаграмму
        generateInteractiveHistogram(dateStats.timeDiff, 'TimeDiff Distribution (Current vs Last Record Time)', 'time_diff_histogram.html');
        
    }
    if (args.stats) {
        const hiddenStats = {};
        let sortedStats = Object.keys(stats).sort((a, b) => stats[b] - stats[a]);
        mainLogger.info('___________________________________________________________________________');
        mainLogger.info('Stats results:');
        sortedStats.forEach(x => {
            if (stats[x] > args.hideStatsLimit) {
                mainLogger.info(`${x} : ${stats[x]}`)
            } else {
                hiddenStats[stats[x]] ? hiddenStats[stats[x]] += 1 : hiddenStats[stats[x]] = 1;
            }
        });
        if (Object.keys(hiddenStats).length > 0) mainLogger.info(`Hidden stats: ${JSON.stringify(hiddenStats)}`);
    }
}



function generateInteractiveHistogram(timeDiffStats, title, filename) {
    if (!timeDiffStats || timeDiffStats.length === 0) {
        mainLogger.info(`No data available for interactive histogram: ${title}`);
        return;
    }
    
    // Получаем массив значений из объекта Stats
    const values = timeDiffStats.data || [];
    
    if (values.length === 0) {
        mainLogger.info(`No data points found for interactive histogram: ${title}`);
        return;
    }
    
    // Конвертируем секунды в дни для лучшего отображения
    const valuesInDays = values.map(val => val / (24 * 60 * 60));
    
    // Создаем HTML файл с интерактивной диаграммой
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>${title}</title>
    <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background-color: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            text-align: center;
            margin-bottom: 30px;
        }
        .stats {
            background-color: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 20px;
        }
        .stat-item {
            display: inline-block;
            margin-right: 20px;
            font-weight: bold;
        }
        .plot-container {
            width: 100%;
            height: 600px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>${title}</h1>
        
        <div class="stats">
            <div class="stat-item">Total Records: ${values.length}</div>
            <div class="stat-item">Min: ${valuesInDays.reduce((a, b) => Math.min(a, b), Infinity).toFixed(2)} days</div>
            <div class="stat-item">Max: ${valuesInDays.reduce((a, b) => Math.max(a, b), -Infinity).toFixed(2)} days</div>
            <div class="stat-item">Mean: ${(valuesInDays.reduce((a, b) => a + b, 0) / valuesInDays.length).toFixed(2)} days</div>
            <div class="stat-item">Median: ${[...valuesInDays].sort((a, b) => a - b)[Math.floor(valuesInDays.length / 2)].toFixed(2)} days</div>
        </div>
        
        <div id="histogram" class="plot-container"></div>
        <div id="boxplot" class="plot-container"></div>
        <div id="cumulative" class="plot-container"></div>
    </div>

    <script>
        const data = ${JSON.stringify(valuesInDays)};
        
        // Гистограмма
        const histogramTrace = {
            x: data,
            type: 'histogram',
            xbins: {
                start: 0,
                end: data.reduce((a, b) => Math.max(a, b), -Infinity) + 25,
                size: 25
            },
            name: 'Distribution',
            marker: {
                color: 'rgba(58, 71, 80, 0.6)',
                line: {
                    color: 'rgba(58, 71, 80, 1.0)',
                    width: 1
                }
            },
            hovertemplate: 'Days: %{x:.2f}<br>Count: %{y}<extra></extra>'
        };
        
        const histogramLayout = {
            title: {
                text: 'Time Difference Distribution',
                font: { size: 18 }
            },
            xaxis: {
                title: 'Time Difference (Days)',
                showgrid: true,
                gridcolor: 'rgba(128,128,128,0.2)'
            },
            yaxis: {
                title: 'Frequency',
                showgrid: true,
                gridcolor: 'rgba(128,128,128,0.2)'
            },
            plot_bgcolor: 'rgba(0,0,0,0)',
            paper_bgcolor: 'rgba(0,0,0,0)',
            showlegend: false,
            margin: { t: 50, b: 50, l: 50, r: 50 }
        };
        
        const histogramConfig = {
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d'],
            displaylogo: false
        };
        
        // Box plot для дополнительной статистики
        const boxplotTrace = {
            y: data,
            type: 'box',
            name: 'Statistics',
            marker: {
                color: 'rgba(255, 127, 14, 0.6)',
                line: {
                    color: 'rgba(255, 127, 14, 1.0)',
                    width: 2
                }
            },
            boxpoints: 'outliers',
            hovertemplate: 'Value: %{y:.2f} days<extra></extra>'
        };
        
        const boxplotLayout = {
            title: {
                text: 'Statistical Summary (Box Plot)',
                font: { size: 18 }
            },
            yaxis: {
                title: 'Time Difference (Days)',
                showgrid: true,
                gridcolor: 'rgba(128,128,128,0.2)'
            },
            plot_bgcolor: 'rgba(0,0,0,0)',
            paper_bgcolor: 'rgba(0,0,0,0)',
            showlegend: false,
            margin: { t: 50, b: 50, l: 50, r: 50 }
        };
        
        // Создаем накопительный график по диапазонам дней
        function createCumulativeChart() {
            // Сортируем данные по возрастанию
            const sortedData = [...data].sort((a, b) => a - b);
            
            // Создаем диапазоны (например, по 10 дней)
            const rangeSize = 25;
            const maxValue = Math.max(...sortedData);
            const ranges = [];
            const cumulativeCounts = [];
            const labels = [];
            
            let cumulativeSum = 0;
            
            for (let i = rangeSize; i <= maxValue + rangeSize; i += rangeSize) {
                const rangeStart = i - rangeSize;
                const rangeEnd = i;
                
                // Считаем количество элементов в текущем диапазоне
                const countInRange = sortedData.filter(val => val >= rangeStart && val < rangeEnd).length;
                
                // Добавляем к накопительной сумме
                cumulativeSum += countInRange;
                
                ranges.push(i);
                cumulativeCounts.push(cumulativeSum);
                labels.push(\`\${rangeStart.toFixed(0)}-\${rangeEnd.toFixed(0)} days\`);
            }
            
            const cumulativeTrace = {
                x: ranges,
                y: cumulativeCounts,
                type: 'scatter',
                mode: 'lines+markers',
                name: 'Cumulative Sum',
                line: {
                    color: 'rgba(31, 119, 180, 1)',
                    width: 3
                },
                marker: {
                    size: 8,
                    color: 'rgba(31, 119, 180, 0.8)'
                },
                hovertemplate: 'Range: up to %{x} days<br>Cumulative Count: %{y}<br><extra></extra>',
                text: labels,
                hoverinfo: 'text+y'
            };
            
            const cumulativeLayout = {
                title: {
                    text: 'Cumulative Distribution by Day Ranges',
                    font: { size: 18 }
                },
                xaxis: {
                    title: 'Day Range (up to)',
                    showgrid: true,
                    gridcolor: 'rgba(128,128,128,0.2)'
                },
                yaxis: {
                    title: 'Cumulative Count of Records',
                    showgrid: true,
                    gridcolor: 'rgba(128,128,128,0.2)'
                },
                plot_bgcolor: 'rgba(0,0,0,0)',
                paper_bgcolor: 'rgba(0,0,0,0)',
                showlegend: true,
                margin: { t: 50, b: 50, l: 50, r: 50 }
            };
            
            return { trace: cumulativeTrace, layout: cumulativeLayout };
        }
        
        const cumulativeChart = createCumulativeChart();
        
        // Создаем графики
        Plotly.newPlot('histogram', [histogramTrace], histogramLayout, histogramConfig);
        Plotly.newPlot('boxplot', [boxplotTrace], boxplotLayout, histogramConfig);
        Plotly.newPlot('cumulative', [cumulativeChart.trace], cumulativeChart.layout, histogramConfig);
    </script>
</body>
</html>`;
    
    try {
        const outputPath = path.resolve(filename);
        fs.writeFileSync(outputPath, htmlContent);
        mainLogger.info(`Interactive histogram saved to: ${outputPath}`);
        mainLogger.info(`Open the file in a browser to view the interactive chart`);
    } catch (error) {
        mainLogger.error(`Failed to save interactive histogram: ${error.message}`);
    }
}