/**
 * Copyright (c) 2020 cinhcet
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
  "use strict";

  const INFLUX = require('@influxdata/influxdb-client');
  const InfluxDB = INFLUX.InfluxDB;
  const InfluxPoint = INFLUX.Point;

  function influxConfig(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.config = config;
    node.influxDB = new InfluxDB({url: config.url, token: node.credentials.token});
    node.queryAPI = node.influxDB.getQueryApi(config.organization);

    node.writeAPIs = new Map();

    node.on('close', function(done) { 
      let p = [];
      node.writeAPIs.forEach(function(writeAPI) {
        p.push(writeAPI.close());
      });
      Promise.all(p)
        .then(function() {
          done();
        })
        .catch(function(e) {
          done(e);
        });
    });
  }
  
  influxConfig.prototype.getWriteAPI = function(bucket, timePrecision, flushInterval) {
    var node = this;
    let identifier = bucket + '__' + timePrecision + '__' + flushInterval;
    if(node.writeAPIs.has(identifier)) {
      return node.writeAPIs.get(identifier);
    } else {
      let writeOptions = {flushInterval: flushInterval};
      let writeAPI = node.influxDB.getWriteApi(node.config.organization, bucket, timePrecision, writeOptions);
      node.writeAPIs.set(identifier, writeAPI);
      return writeAPI;
    }
  }

  RED.nodes.registerType("influxdb-v2 config", influxConfig, {
    credentials: {
      token: {type: "password"}
    }
  });

  
  function influxQuery(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.influxDB = RED.nodes.getNode(config.influxDB);

    node.on('input', function(m, send, done) {
      if(m.payload && typeof m.payload === 'string') {
        let result = [];
        node.influxDB.queryAPI.queryRows(m.payload, {
          next(row, tableMeta) {
            let entry = {};
            for(let i = 0; i < tableMeta.columns.length && i < row.length; i++) {
              let value = row[i];
              let column = tableMeta.columns[i];
              entry[column.label] = {value: value, dataType: column.dataType};
            }
            result.push(entry);
          },
          error(error) {
            done(error);
          },
          complete() {
            m.payload = result;
            send(m);
            done();
          },
        });
      } else {
        done('payload not a string');
      }
    });

  }
  RED.nodes.registerType("influxdb-v2 query", influxQuery);



  function influxWrite(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.config = config;
    node.influxDB = RED.nodes.getNode(config.influxDB);

    node.on('input', function(m, send, done) {
      if(m.payload && m.bucket) {
        let flushInterval = node.config.flushInterval > 0 ? node.config.flushInterval : 1;
        let writeAPI = node.influxDB.getWriteAPI(m.bucket, node.config.timePrecision, flushInterval);

        let data = Array.isArray(m.payload) ? m.payload : [m.payload];
        
        let influxDataPoints = [];

        for(let i = 0; i < data.length; i++) {
          let d = data[i];
          if(d.measurement) {
            if(d.fields) {
              let dataPoint = new InfluxPoint(d.measurement);

              Object.keys(d.fields).forEach(function(fieldName) {
                let field = d.fields[fieldName];
                if(typeof field === 'number') {
                  dataPoint.floatField(fieldName, field);
                } else if(typeof field === 'string') {
                  dataPoint.stringField(fieldName, field);
                } else if(typeof field === 'boolean') {
                  dataPoint.booleanField(fieldName, field);
                } else if(typeof field === 'object') {
                  try {
                    dataPoint.stringField(fieldName, JSON.stringify(field));
                  } catch(e) {
                    node.error(e);
                  }
                } else {
                  node.warn('type ' + typeof field + ' not supported')
                }
              });

              if(d.tags) {
                Object.keys(d.tags).forEach(function(tagName) {
                  dataPoint.tag(tagName, d.tags[tagName]);
                });
              }

              if(d.timestamp) {
                dataPoint.timestamp(d.timestamp);
              }

              influxDataPoints.push(dataPoint);

            } else {
              node.error('at least one field is required');
            }
          } else {
            node.error('measurement required');
          }
        }

        if(influxDataPoints.length) {
          writeAPI.writePoints(influxDataPoints);
          if(node.config.flushInterval === 0) {
            writeAPI.flush();
          }
        }
        done();

      } else {
        done('message malformed');
      }
    });
  }
  RED.nodes.registerType("influxdb-v2 write", influxWrite);
}