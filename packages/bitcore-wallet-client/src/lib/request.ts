import * as _ from 'lodash';
import { Utils } from './common';

const request = require('superagent');
const async = require('async');
const Package = require('../../package.json');
var log = require('./log');

const util = require('util');
var Errors = require('./errors');

export class Request {
  baseUrl: any;
  session: any;
  r: any;
  credentials: any;
  supportStaffWalletId: any;
  timeout: any;

  constructor(url?, opts?) {
    this.baseUrl = url;

    this.r = opts.r || request;
    this.supportStaffWalletId = opts.supportStaffWalletId;

    this.session = null;
    this.credentials = null;
  }

  setCredentials(credentials) {
    this.credentials = credentials;
  }

  getHeaders(method: string, url: string, args: any, useSession?: boolean) {
    var headers = {
      'x-client-version': 'bwc-' + Package.version
    };
    if (this.supportStaffWalletId) {
      headers['x-wallet-id'] = this.supportStaffWalletId;
    }

    this._populateAuth(headers, { method, url, args }, useSession);

    return headers;
  }

  _populateAuth(
    headers: any,
    signingParams: {
      method: string;
      url: string;
      args: any;
      _requestPrivKey?: string;
    },
    useSession?: boolean
  ) {
    if (this.credentials) {
      headers['x-identity'] = this.credentials.copayerId;

      if (useSession && this.session) {
        headers['x-session'] = this.session;
      } else {
        const { _requestPrivKey, ...params } = signingParams;
        const privKey = _requestPrivKey || this.credentials.requestPrivKey;
        if (privKey) {
          headers['x-signature'] = this._signRequest({ ...params, privKey });
        }
      }
    }
  }

  /**
   * @description sign an HTTP request
   * @private
   * @param {String} params.method the HTTP method
   * @param {String} params.url the URL for the request
   * @param {String} params.privKey private key to sign the request
   * @param {Object} params.args a POST/PUT request
   */
  _signRequest({ method, url, args, privKey }) {
    var message = `${method.toLowerCase()}|${url}|${JSON.stringify(args)}`;
    return Utils.signMessage(message, privKey);
  }

  doRequest(method, url, args, useSession, cb) {
    var headers = this.getHeaders(method, url, args, useSession);

    var r = this.r[method](this.baseUrl + url);
    r.accept('json');

    _.each(headers, (v, k) => {
      if (v) r.set(k, v);
    });

    if (args) {
      if (method == 'post' || method == 'put') {
        r.send(args);
      } else {
        r.query(args);
      }
    }

    r.timeout(this.timeout);

    r.end((err, res) => {
      if (!res) {
        return cb(new Errors.CONNECTION_ERROR());
      }

      if (res.body)
        log.debug(
          util.inspect(res.body, {
            depth: 10
          })
        );

      if (res.status !== 200) {
        if (res.status === 503) return cb(new Errors.MAINTENANCE_ERROR());
        if (res.status === 404) return cb(new Errors.NOT_FOUND());
        if (res.status === 413) return cb(new Errors.PAYLOAD_TOO_LARGE());
        if (!res.status) return cb(new Errors.CONNECTION_ERROR());

        log.error('HTTP Error:' + res.status);

        if (!res.body || !Object.keys(res.body).length)
          return cb(new Error(res.status + `${err?.message ? ': ' + err.message : ''}`));
        return cb(Request._parseError(res.body));
      }

      if (res.body === '{"error":"read ECONNRESET"}')
        return cb(new Errors.ECONNRESET_ERROR(JSON.parse(res.body)));

      return cb(null, res.body, res.header);
    });
  }

  //  Parse errors
  //  @private
  //  @static
  //  @memberof Client.API
  //  @param {Object} body
  static _parseError(body) {
    if (!body) return;

    if (_.isString(body)) {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {
          error: body
        };
      }
    }
    var ret;
    if (body.code) {
      if (Errors[body.code]) {
        ret = new Errors[body.code]();
        if (body.message) ret.message = body.message;
        if (body.messageData) ret.messageData = body.messageData;
      } else {
        ret = new Error(
          body.code +
            ': ' +
            (_.isObject(body.message)
              ? JSON.stringify(body.message)
              : body.message)
        );
      }
    } else {
      ret = new Error(body.error || JSON.stringify(body));
    }
    log.error(ret);
    return ret;
  }

  //  Do a POST request
  //  @private
  //
  //  @param {String} url
  //  @param {Object} args
  //  @param {Callback} cb
  post(url, args, cb) {
    args = args || {};
    return this.doRequest('post', url, args, false, cb);
  }

  put(url, args, cb) {
    args = args || {};
    return this.doRequest('put', url, args, false, cb);
  }

  //  Do a GET request
  //  @private
  //
  //  @param {String} url
  //  @param {Callback} cb
  get(url, cb) {
    url += url.indexOf('?') > 0 ? '&' : '?';
    url += 'r=' + _.random(10000, 99999);

    return this.doRequest('get', url, {}, false, cb);
  }

  getWithLogin(url, cb) {
    url += url.indexOf('?') > 0 ? '&' : '?';
    url += 'r=' + _.random(10000, 99999);
    return this.doRequestWithLogin('get', url, {}, cb);
  }

  _login(cb) {
    this.post('/v1/login', {}, cb);
  }

  logout(cb) {
    this.post('/v1/logout', {}, cb);
  }

  //  Do an HTTP request
  //  @private
  //
  //  @param {Object} method
  //  @param {String} url
  //  @param {Object} args
  //  @param {Callback} cb
  doRequestWithLogin(method, url, args, cb) {
    async.waterfall(
      [
        next => {
          if (this.session) return next();
          this.doLogin(next);
        },
        next => {
          this.doRequest(method, url, args, true, (err, body, header) => {
            if (err && err instanceof Errors.NOT_AUTHORIZED) {
              this.doLogin(err => {
                if (err) return next(err);
                return this.doRequest(method, url, args, true, next);
              });
            }
            next(null, body, header);
          });
        }
      ],
      cb
    );
  }

  doLogin(cb) {
    this._login((err, s) => {
      if (err) return cb(err);
      if (!s) return cb(new Errors.NOT_AUTHORIZED());
      this.session = s;
      cb();
    });
  }

  // Do a DELETE request
  // @private
  //
  // @param {String} url
  // @param {Callback} cb

  delete(url, cb) {
    return this.doRequest('delete', url, {}, false, cb);
  }
}
