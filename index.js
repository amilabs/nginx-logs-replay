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
program.version(process.env.npm_package_version);

const defaultFormat = '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"';
const defaultFormatTime = 'DD/MMM/YYYY:HH:mm:ss Z';

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
    .option('--skipSleep', 'remove pauses between requests. Attention: will ddos your server', false)
    .option('--skipSsl', 'skip ssl errors', false)
    .option('--datesFormat <string>', 'format of dates to display in logs (regarding Moment.js parsing format)', "DD-MM-YYYY:HH:mm:ss")
    .option('-s, --stats', 'show stats of the requests', false)
    .option('--deleteQueryStats [strings...]', 'delete some query for calculating stats, eg: "page limit size"', [])
    .option('--statsOnlyPath', 'keep only endpoints for showing stats', false)
    .option('--filterOnly [strings...]', 'filter logs for replaying, eg: "/test data .php"', [])
    .option('--filterSkip [strings...]', 'skip logs for replaying, eg: "/test data .php"', [])
    .option('--customQueryParams [strings...]', 'additional query params fro requests, eg: "test=true size=3"', [])
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
let totalResponseTime = 0;
let startTime = 0;
let finishTime = 0;
let totalSleepTime = 0;
let numStats = new Stats();

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

args.startTimestamp = args.startTimestamp.length>10? args.startTimestamp: args.startTimestamp*1000;
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
        const timestamp = startTimestamp + 1000*i/args.generatorModeRPS;
        const randomInt = between(Number(args.generatorModeMinLength), Number(args.generatorModeMaxLength))
        let randomString = '';
        for (let i = 0; i < randomInt; i++) {
            randomString+=alphabet[Math.floor(Math.random()*alphabet.length)];
        }
        dataArray.push({
            agent: "generator",
            status: "200",
            req: `GET ${randomString}`,
            timestamp
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
    if (args.timeout) config.timeout = args.timeout;
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
    if (originalStatus !== response.status.toString()) {
        debugLogger.info(`Response for ${url} has different status code: ${response.status} and ${originalStatus}`);
        numberOfFailedEvents += 1;
    } else {
        numberOfSuccessfulEvents += 1;
    }
    if (response.data && response.data.results && response.data.results.length>0) numberOfNotEmptyResponses+=1;
    let responseTime = +new Date() - sendTime;
    totalResponseTime += responseTime;
    numStats.push(responseTime);
    if (response.data.debug){
        for (const [field, fieldValue] of Object.entries(response.data.debug)){
            if (statsMetrics[field]===undefined){
                statsMetrics[field]={num: new Stats(), time: new Stats()};
            }
            if (fieldValue){
                if (fieldValue["num"]!==undefined){
                    statsMetrics[field]["num"].push(fieldValue["num"]);
                }
                if (fieldValue["time"]!==undefined){
                    statsMetrics[field]["time"].push(fieldValue["time"]);
                }
                if (fieldValue["queries"]){
                    for (const [subField, subValue] of Object.entries(response.data.debug[field]["queries"])){
                        if (statsMetrics[field+"."+subField]===undefined){
                            statsMetrics[field+"."+subField] = {};
                            statsMetrics[field+"."+subField]={time: new Stats()};
                        }
                        statsMetrics[field+"."+subField]["time"].push(subValue)
                    }
                }
            }
        }
    }
    resultLogger.info(`${response.status}     ${originalStatus}     ${Moment.unix(timestamp / 1000).format(args.datesFormat)}     ${Moment.unix(sendTime / 1000).format(args.datesFormat)}     ${(responseTime / 1000).toFixed(2)}     ${url}`)
    if (response.data.debug) debugLogger.info(JSON.stringify(response.data.debug));
}

function getPercentile(stat, toSeconds=false){
    const percentiles = [1,5,25,50,75,95,99];
    let percentilesObject = {};
    percentiles.forEach(percentile=>{
        percentilesObject[percentile] = (stat.percentile(percentile)/(toSeconds?1000:1)).toFixed(3)
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
    mainLogger.info(`Response time: ${JSON.stringify(getResponseTime(numStats,true))}`);
    mainLogger.info(`Percentile: ${JSON.stringify(getPercentile(numStats, true))}`);

    Object.keys(statsMetrics).forEach(field=>{
        if (statsMetrics[field]["time"].length>0 && statsMetrics[field]["time"].length!==statsMetrics[field]["time"].zeroes){
            mainLogger.info(`${field} time: ${JSON.stringify(getResponseTime(statsMetrics[field]["time"], false))}`);
            mainLogger.info(`${field} time percentile: ${JSON.stringify(getPercentile(statsMetrics[field]["time"]))}`);
        }
        if (statsMetrics[field]["num"]&&statsMetrics[field]["num"].length>0 && statsMetrics[field]["num"].length!==statsMetrics[field]["num"].zeroes){
            mainLogger.info(`${field} number: ${JSON.stringify(getResponseTime(statsMetrics[field]["num"], false,0))}`);
        }
    });

    mainLogger.info(`Total requests time: ${(finishTime - startTime) / 1000} seconds. Total sleep time: ${(totalSleepTime / 1000).toFixed(2)} seconds.`);
    mainLogger.info(`Original time: ${(dataArray[dataArray.length - 1].timestamp - dataArray[0].timestamp) / 1000} seconds. Original rps: ${(1000 * dataArray.length / (dataArray[dataArray.length - 1].timestamp - dataArray[0].timestamp)).toFixed(4)}. Replay rps: ${((numberOfSuccessfulEvents+numberOfFailedEvents) * 1000 / (finishTime - startTime)).toFixed(4)}. Ratio: ${args.ratio}.`);
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
        if (Object.keys(hiddenStats) > 0) mainLogger.info(`Hidden stats: ${JSON.stringify(hiddenStats)}`);
    }
}

function between(min, max) {
    return Math.floor(Math.random() * (max-min) + min) + 1;
}
