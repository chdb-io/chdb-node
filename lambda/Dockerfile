FROM amazon/aws-lambda-nodejs:16
COPY libchdb.so /var/lib/libchdb.so
COPY index.js package.json ./
RUN npm install
CMD [ "index.handler" ]
