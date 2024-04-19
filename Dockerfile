FROM node:20.11-alpine AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY . /usr/src/app
ENTRYPOINT [ "node", "index.js" ]