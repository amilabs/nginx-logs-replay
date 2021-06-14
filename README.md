# nginx-logs-replay
Replay nginx-like logs into a test HTTP server for stress testing.

## Installation

```
npm i -g @amilabs/nginx-logs-replay
```

## Usage

```
Usage of nginx-replay:

Options:
  -f, --filePath <path>            path of the nginx logs file
  -p, --prefix <url>               url for sending requests
  -r, --ratio <number>             acceleration / deceleration rate of sending requests, eg: 2, 0.5 (default: "1")
  --format <string>                format of the nginx log (default: "$remote_addr - $remote_user [$time_local] \"$request\" $status $body_bytes_sent \"$http_referer\" \"$http_user_agent\"")
  --formatTime <string>            format of the nginx time (default: "DD/MMM/YYYY:HH:mm:ss Z")
  --startTimestamp <number>        start replaying logs from this timestamp (default: "0")
  -d --debug                       show debug messages in console (default: false)
  -l, --logFile <path>             save results to the logs file (default: "")
  -t, --timeout <int>              timeout fo the requests
  --username <string>              username for basic auth
  --password <string>              password  for basic auth
  --scaleMode                      experimental mode for the changing requests order (default: false)
  --skipSleep                      remove pauses between requests. Attention: will ddos your server (default: false)
  --skipSsl                        skip ssl errors (default: false)
  --datesFormat <string>           format of dates to display in logs (regarding Moment.js parsing format) (default: "DD-MM-YYYY:HH:mm:ss")
  -s, --stats                      show stats of the requests (default: false)
  --deleteQueryStats [strings...]  delete some query for calculating stats, eg: "page limit size" (default: "")
  --statsOnlyPath                  keep only endpoints for showing stats (default: false)
  --filterOnly [strings...]        filter logs for replaying, eg: "/test data .php" (default: [])
  --filterSkip [strings...]        skip logs for replaying, eg: "/test data .php" (default: [])
  --hideStatsLimit <int>           limit number of stats (default: "0")
  -h, --help                       display help for command

```

```bash
# Replay access log
nginx-replay -f nginx-acces.log -p localhost -d -l out.log -s
```

## Output log format

Log is 5 spaces separated values:
```
replay-status   original-status   start-time-at-log      replay-start-time     duration   url

     403              200        22-04-2021:03:46:32    26-04-2021:03:59:29      0.32     /enpoint?page=1
```

* replay-status is integer
* original-status is integer
* start-time-at-log is formatted date(format can be changed)
* replay-start-time is formatted date(format can be changed)
* duration is in seconds
* url is string like in nginx log file

## What is stats?

Calculated list of top urls. You can hide some rare requests by passing hideStatsLimit option.
Also you can remove some or all query by passing deleteQueryStats or statsOnlyPath options.

## What is final info?

Some useful information and statistic about requests, rps, errors end etc.