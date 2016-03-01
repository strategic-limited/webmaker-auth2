var express = require('express');
var hyperquest = require('hyperquest');

module.exports = function (options) {

  options = options || {};

  var self = this;

  var ONE_YEAR = 60 * 60 * 24 * 7;// 31536000000;

  // missing session secret
  if (!options.secretKey) {
    throw new Error('(webmaker-auth): secretKey was not passed into webmaker-auth');
  }

  // missing login URL
  if (!options.loginURL) {
    throw new Error('(webmaker-auth): loginURL was not passed into webmaker-auth');
  }

  // missing Login Host URL
  if (!options.loginHost) {
    throw new Error('(webmaker-auth): loginHost was not passed into webmaker-auth');
  }

  self.loginURL = options.loginURL;
  self.authLoginURL = options.authLoginURL;
  self.loginHost = options.loginHost;
  self.allowCors = options.allowCors;

  self.refreshTime = options.refreshTime || 1000 * 60 * 15; // 15 minutes

  self.forceSSL = options.forceSSL || false;
  self.secretKey = options.secretKey;
  self.domain = options.domain;
  self.cookieName = 'webmakerlogin';

  self.getLoginUrl = function getLoginUrl(req) {
    return req.whitelabel ? req.whitelabel.getLoginUrl() : self.loginURL;
  };

  self.getAuthLoginUrl = function getAuthLoginUrl(req) {
    return req.whitelabel ? req.whitelabel.getLoginUrlWithAuth() : self.authLoginURL;
  };

  self.cookieParser = function () {
    return express.cookieParser();
  };

  self.extractWhitelabel = require('./lib/extract-whitelabel')(self);

  self.cookieSession = function () {
    var options = {
      key: self.cookieName,
      secret: self.secretKey,
      cookie: {
        expires: false,
        secure: self.forceSSL
      },
      proxy: true
    };

    if (self.domain) {
      options.cookie.domain = self.domain;
    }

    var cookieSessionMiddleware = express.cookieSession(options);

    var whitelabelSessionsCache = {};

    var copyOptionsWithDomain = function (options, cookieDomain) {

      var result = JSON.parse(JSON.stringify(options));
      result.cookie.domain = cookieDomain;

      return result;
    };

    // This is a work-around for cross-origin OPTIONS requests
    // See https://github.com/senchalabs/connect/issues/323
    return function (req, res, next) {
      if (req.method.toLowerCase() === 'options') {
        return next();
      } else {
        // we allow req.whitelabel to override cookieDomain
        var cookieDomain = req.whitelabel && req.whitelabel.cookieDomain;
        if (cookieDomain) {
          var hostSession = whitelabelSessionsCache[cookieDomain];
          if (!hostSession) {
            hostSession = whitelabelSessionsCache[cookieDomain] = express.cookieSession(copyOptionsWithDomain(options, cookieDomain));
          }
          hostSession(req, res, next);
        } else {
          cookieSessionMiddleware(req, res, next);
        }
      }
    };

  };

  function authenticateCallback(err, req, res, json) {
    if (err) {
      return res.json(500, {
        error: err
      });
    }
    if (!json) {
      return res.json(500, {
        error: 'The Login server sent an invalid response'
      });
    }
    if (json.error) {
      return res.json({
        error: json.error
      });
    }
    if (json.user) {
      if (req.body.validFor === 'one-year') {
        req.session.cookie.maxAge = ONE_YEAR;
      }

      req.session.user = json.user;
      req.session.email = json.email;
      req.session.refreshAfter = Date.now() + self.refreshTime;
      res.json({
        user: json.user,
        email: json.email
      });
    } else {
      res.json({
        error: 'No user for email address',
        email: json.email
      });
    }
  }

  function refreshSession(req, res, next) {
    var hReq = hyperquest.get({
      uri: self.getAuthLoginUrl(req) + '/user/id/' + req.session.user.id
    });
    hReq.on('error', next);
    hReq.on('response', function (resp) {
      if (resp.statusCode !== 200) {
        return res.json(resp.statusCode || 500, {
          error: 'There was an error on the login server'
        });
      }
      var bodyParts = [];
      var bytes = 0;
      resp.on('data', function (c) {
        bodyParts.push(c);
        bytes += c.length;
      });
      resp.on('end', function () {
        var body = Buffer.concat(bodyParts, bytes).toString('utf8');
        var json;

        try {
          json = JSON.parse(body);
        } catch (ex) {
          return authenticateCallback(ex, req, res);
        }
        var temprole = [];
        json.user.roles.forEach(function(role){
          if (role) {
            if (role.hasOwnProperty("name")) {
              temprole.push(role.name);
            } else {
              if (role) { temprole.push(role); }
            }
          }
        });
        if (temprole.length > 0) {
          json.user.roles = temprole;
        }

        json.email = json.user.email;
        authenticateCallback(null, req, res, json);
      });
    });
  }

  function getIPAddress(req) {
    // account for load balancer!
    if (options.forceSSL) {
      return req.headers['x-forwarded-for'];
    }

    return req.connection.remoteAddress;
  }

  self.handlers = options.testMode ? require('./testmode')(options) : {
    request: function (req, res, next) {

      if (!req.body.uid) {
        return res.json(400, {
          error: 'missing email or username'
        });
      }

      if (!req.body.path) {
        req.body.path = '';
      }

      var hReq = hyperquest.post({
        headers: {
          'Content-Type': 'application/json',
          'x-ratelimit-ip': getIPAddress(req)
        },
        uri: self.getAuthLoginUrl(req) + '/api/v2/user/request'
      });
      hReq.on('error', next);
      hReq.on('response', function (resp) {

        if (resp.statusCode === 429) {
          res.set({
            'x-ratelimit-limit': resp.headers['x-ratelimit-limit'],
            'x-ratelimit-remaining': resp.headers['x-ratelimit-remaining'],
            'retry-after': resp.headers['retry-after']
          });
          return res.json(resp.statusCode, {
            error: 'Request Limit Exceeded'
          });
        }

        var bodyParts = [];
        var bytes = 0;
        resp.on('data', function (c) {
          bodyParts.push(c);
          bytes += c.length;
        });
        resp.on('end', function () {
          var body = Buffer.concat(bodyParts, bytes).toString('utf8');
          var json;

          try {
            json = JSON.parse(body);
          } catch (ex) {
            return authenticateCallback(ex, req, res);
          }

          res.json(json);
        });
      });

      var appURL;
      if (req.headers.origin && self.allowCors && (self.allowCors[0] === '*' || self.allowCors.indexOf(req.headers.origin) > -1)) {
        appURL = req.headers.origin;
      } else {
        appURL = self.loginHost;
      }
      hReq.end(JSON.stringify({
        uid: req.body.uid,
        appURL: appURL + req.body.path
      }), 'utf8');
    },
    authenticateToken: function (req, res, next) {
      if (!req.body.uid || !req.body.token) {
        return res.json(400, {
          error: 'uid and token are required'
        });
      }
      var hReq = hyperquest.post({
        headers: {
          'Content-Type': 'application/json',
          'x-ratelimit-ip': getIPAddress(req)
        },
        uri: self.getAuthLoginUrl(req) + '/api/v2/user/authenticateToken'
      });
      hReq.on('error', next);
      hReq.on('response', function (resp) {
        if (resp.statusCode !== 200) {
          if (resp.statusCode === 429) {
            res.set({
              'x-ratelimit-limit': resp.headers['x-ratelimit-limit'],
              'x-ratelimit-remaining': resp.headers['x-ratelimit-remaining'],
              'retry-after': resp.headers['retry-after']
            });
            return res.json(resp.statusCode, {
              error: 'Request Limit Exceeded'
            });
          }
          return res.json(resp.statusCode || 500, {
            error: resp.statusCode === 401 ? 'unauthorized' : 'There was an error on the login server'
          });
        }

        var bodyParts = [];
        var bytes = 0;
        resp.on('data', function (c) {
          bodyParts.push(c);
          bytes += c.length;
        });
        resp.on('end', function () {
          var body = Buffer.concat(bodyParts, bytes).toString('utf8');
          var json;

          try {
            json = JSON.parse(body);
          } catch (ex) {
            return authenticateCallback(ex, req, res);
          }

          authenticateCallback(null, req, res, json);
        });
      });
      hReq.end(JSON.stringify({
        uid: req.body.uid,
        token: req.body.token,
        user: req.body.user
      }), 'utf8');
    },
    authenticate: function (req, res, next) {
      var hReq = hyperquest.post({
        headers: {
          'Content-Type': 'application/json'
        },
        uri: self.getLoginUrl(req) + '/api/user/authenticate'
      });
      hReq.on('error', next);
      hReq.on('response', function (resp) {
        if (resp.statusCode !== 200) {
          return res.json(resp.statusCode || 500, {
            error: 'There was an error on the login server'
          });
        }

        var bodyParts = [];
        var bytes = 0;
        resp.on('data', function (c) {
          bodyParts.push(c);
          bytes += c.length;
        });
        resp.on('end', function () {
          var body = Buffer.concat(bodyParts, bytes).toString('utf8');
          var json;

          try {
            json = JSON.parse(body);
          } catch (ex) {
            return authenticateCallback(ex, req, res);
          }

          authenticateCallback(null, req, res, json);
        });
      });
      hReq.end(JSON.stringify({
        assertion: req.body.assertion,
        audience: req.body.audience,
        user: req.body.user
      }), 'utf8');
    },
    uidExists: function (req, res, next) {
      if (!req.body.uid) {
        return res.json(400, {
          error: 'Missing uid param'
        });
      }
      var hReq = hyperquest.post({
        headers: {
          'Content-Type': 'application/json'
        },
        uri: self.getAuthLoginUrl(req) + '/api/v2/user/exists'
      });
      hReq.on('error', next);
      hReq.on('response', function (resp) {
        if (resp.statusCode !== 200) {
          if (resp.statusCode === 404) {
            return res.json({
              exists: false
            });
          }
          return res.json(resp.statusCode || 500, {
            error: 'There was an error on the login server'
          });
        }
        var bodyParts = [];
        var bytes = 0;
        resp.on('data', function (c) {
          bodyParts.push(c);
          bytes += c.length;
        });
        resp.on('end', function () {
          var body = Buffer.concat(bodyParts, bytes).toString('utf8');
          var json;

          try {
            json = JSON.parse(body);
          } catch (ex) {
            return res.json(500, {
              error: 'invalid response from login server'
            });
          }

          res.json({
            exists: json.exists,
            usePasswordLogin: json.usePasswordLogin,
            verified: json.verified
          });
        });
      });
      hReq.end(JSON.stringify({
        uid: req.body.uid
      }), 'utf8');

    },
    verify: function (req, res, next) {
      if (!req.session.email && !req.session.user) {
        return res.json({
          status: 'No Sessions'
        });
      }

      if (self.authLoginURL && (req.session.user.roles.length <= 0 || !req.session.refreshAfter || req.session.refreshAfter < Date.now())) {
        return refreshSession(req, res, next);
      }

      var temprole = [];
      req.session.user.roles.forEach(function(role){
        if (role) {
          if (role.hasOwnProperty("name")) {
            temprole.push(role.name);
          } else {
            if (role) { temprole.push(role); }
          }
        }
      });
      if (temprole.length > 0) {
        req.session.user.roles = temprole;
      }

      res.json({
        status: 'Valid Session user get details',
        user: req.session.user,
        email: req.session.email
      });

    },
    createUser: function (req, res, next) {
      var hReq = hyperquest.post({
        headers: {
          'Content-Type': 'application/json',
          'x-ratelimit-ip': getIPAddress(req)
        },
        uri: self.getLoginUrl(req) + '/api/v2/user/create'
      });
      hReq.on('error', next);
      hReq.on('response', function (resp) {
        if (resp.statusCode !== 200) {
          if (resp.statusCode === 429) {
            res.set({
              'x-ratelimit-limit': resp.headers['x-ratelimit-limit'],
              'x-ratelimit-remaining': resp.headers['x-ratelimit-remaining'],
              'retry-after': resp.headers['retry-after']
            });
            return res.json(resp.statusCode, {
              error: 'Request Limit Exceeded'
            });
          }
          return res.json(resp.statusCode || 500, {
            error: 'There was an error on the login server'
          });
        }

        var bodyParts = [];
        var bytes = 0;
        resp.on('data', function (c) {
          bodyParts.push(c);
          bytes += c.length;
        });
        resp.on('end', function () {
          var body = Buffer.concat(bodyParts, bytes).toString('utf8');
          var json;

          try {
            json = JSON.parse(body);
          } catch (ex) {
            return res.json(500, {
              error: 'There was an error parsing the response from the Login Server'
            });
          }

          if (!json.user) {
            return res.json(500, {
              error: 'Error creating an account - \"' + json.error + '\"'
            });
          }

          req.session.user = json.user;
          req.session.email = json.email;
          res.json({
            user: json.user,
            email: json.email
          });
        });
      });

      hReq.end(JSON.stringify({
        audience: req.body.audience,
        user: req.body.user
      }), 'utf8');
    },
    logout: function (req, res) {
      req.session.email = req.session.user = req.session.refreshAfter = null;
      res.json({
        status: 'okay'
      });
    },
    tos: function(req, res, next) {
      if (!req.session.email && !req.session.user) {
        return res.json({
          status: 'No Session'
        });
      }
      var hReq = hyperquest.post({
        headers: {
          'Content-Type': 'application/json'
        },
        uri: self.getAuthLoginUrl(req) + '/api/v2/user/tos'
      });
      hReq.on('error', next);
      hReq.on('response', function (resp) {
        if (res.statusCode !== 200) {
          if (resp.statusCode === 404) {
            return res.json({
              tos: false
            });
          }
          return res.json(resp.statusCode || 500, {
            error: 'There was a error on the login server'
          });
        }
      });
      hReq.end(JSON.stringify({
        uid: req.session.user.email,
        tos: true
      }), 'utf8');
    },
    verifyPassword: function (req, res, next) {
      if (!req.body.uid || !req.body.password) {
        return res.json(400, {
          error: 'Missing email or password param'
        });
      }
      var hReq = hyperquest.post({
        headers: {
          'Content-Type': 'application/json',
          'x-ratelimit-ip': getIPAddress(req)
        },
        uri: self.getAuthLoginUrl(req) + '/api/v2/user/verify-password'
      });
      hReq.on('error', next);
      hReq.on('response', function (resp) {
        if (resp.statusCode !== 200) {
          if (resp.statusCode === 429) {
            res.set({
              'x-ratelimit-limit': resp.headers['x-ratelimit-limit'],
              'x-ratelimit-remaining': resp.headers['x-ratelimit-remaining'],
              'retry-after': resp.headers['retry-after']
            });
            return res.json(resp.statusCode, {
              error: 'Request Limit Exceeded'
            });
          }
          return res.json(401, {
            status: 'unauthorized'
          });
        }

        var bodyParts = [];
        var bytes = 0;
        resp.on('data', function (c) {
          bodyParts.push(c);
          bytes += c.length;
        });
        resp.on('end', function () {
          var body = Buffer.concat(bodyParts, bytes).toString('utf8');
          var json;

          try {
            json = JSON.parse(body);
          } catch (ex) {
            return authenticateCallback(ex, req, res);
          }

          authenticateCallback(null, req, res, json);
        });
      });

      hReq.end(JSON.stringify({
        password: req.body.password,
        uid: req.body.uid,
        user: req.body.user
      }), 'utf8');
    },
    requestResetCode: function (req, res, next) {
      if (!req.body.uid) {
        return res.json(400, {
          error: 'Missing email or username'
        });
      }
      var hReq = hyperquest.post({
        headers: {
          'Content-Type': 'application/json',
          'x-ratelimit-ip': getIPAddress(req)
        },
        uri: self.getAuthLoginUrl(req) + '/api/v2/user/request-reset-code'
      });
      hReq.on('error', next);
      hReq.on('response', function (resp) {
        if (resp.statusCode !== 200) {
          if (resp.statusCode === 429) {
            res.set({
              'x-ratelimit-limit': resp.headers['x-ratelimit-limit'],
              'x-ratelimit-remaining': resp.headers['x-ratelimit-remaining'],
              'retry-after': resp.headers['retry-after']
            });
            return res.json(resp.statusCode, {
              error: 'Request Limit Exceeded'
            });
          }
          return res.json(resp.statusCode || 500, {
            error: 'There was an error on the login server'
          });
        }

        var bodyParts = [];
        var bytes = 0;
        resp.on('data', function (c) {
          bodyParts.push(c);
          bytes += c.length;
        });
        resp.on('end', function () {
          var body = Buffer.concat(bodyParts, bytes).toString('utf8');
          var json;

          try {
            json = JSON.parse(body);
          } catch (ex) {
            return res.json(500, {
              error: 'There was an error parsing the response from the server'
            });
          }

          res.json(json);
        });
      });
      hReq.end(JSON.stringify({
        uid: req.body.uid
      }), 'utf8');
    },
    resetPassword: function (req, res, next) {
      var body = req.body;
      if (!body.uid || !body.resetCode || !body.newPassword) {
        return res.json(400, {
          error: 'Missing required parameters'
        });
      }
      var hReq = hyperquest.post({
        headers: {
          'Content-Type': 'application/json',
          'x-ratelimit-ip': getIPAddress(req)
        },
        uri: self.getAuthLoginUrl(req) + '/api/v2/user/reset-password'
      });
      hReq.on('error', next);
      hReq.on('response', function (resp) {
        if (resp.statusCode !== 200 &&
          resp.statusCode !== 400 &&
          resp.statusCode !== 401) {
          if (resp.statusCode === 429) {
            res.set({
              'x-ratelimit-limit': resp.headers['x-ratelimit-limit'],
              'x-ratelimit-remaining': resp.headers['x-ratelimit-remaining'],
              'retry-after': resp.headers['retry-after']
            });
            return res.json(resp.statusCode, {
              error: 'Request Limit Exceeded'
            });
          }
          return res.json(500, {
            error: 'There was an error on the login server'
          });
        }

        var bodyParts = [];
        var bytes = 0;
        resp.on('data', function (c) {
          bodyParts.push(c);
          bytes += c.length;
        });
        resp.on('end', function () {
          var body = Buffer.concat(bodyParts, bytes).toString('utf8');
          var json;

          try {
            json = JSON.parse(body);
          } catch (ex) {
            return res.json(500, {
              error: 'There was an error parsing the response from the server'
            });
          }

          res.json(resp.statusCode, json);
        });
      });
      hReq.end(JSON.stringify({
        uid: body.uid,
        resetCode: body.resetCode,
        newPassword: body.newPassword
      }), 'utf8');
    },
    removePassword: function (req, res, next) {
      if (!req.session.user) {
        return res.json(401, {
          status: 'unauthorized'
        });
      }

      var hReq = hyperquest.post({
        headers: {
          'Content-Type': 'application/json'
        },
        uri: self.getAuthLoginUrl(req) + '/api/v2/user/remove-password'
      });
      hReq.on('error', next);
      hReq.on('response', function (resp) {
        if (resp.statusCode !== 200) {
          return res.json(500, {
            error: 'There was an error on the login server'
          });
        }

        var bodyParts = [];
        var bytes = 0;
        resp.on('data', function (c) {
          bodyParts.push(c);
          bytes += c.length;
        });
        resp.on('end', function () {
          var body = Buffer.concat(bodyParts, bytes).toString('utf8');
          var json;

          try {
            json = JSON.parse(body);
          } catch (ex) {
            return res.json(500, {
              error: 'There was an error parsing the response from the server'
            });
          }

          authenticateCallback(null, req, res, json);
        });
      });
      hReq.end(JSON.stringify({
        uid: req.session.user.email
      }), 'utf8');
    },
    enablePasswords: function (req, res, next) {
      var body = req.body;

      if (!req.session.user) {
        return res.json(401, {
          status: 'unauthorized'
        });
      }

      if (!body.password) {
        return res.json(400, {
          error: 'check parameters'
        });
      }
      var hReq = hyperquest.post({
        headers: {
          'Content-Type': 'application/json'
        },
        uri: self.getAuthLoginUrl(req) + '/api/v2/user/enable-passwords'
      });
      hReq.on('error', next);
      hReq.on('response', function (resp) {
        var bodyParts = [];
        var bytes = 0;
        resp.on('data', function (c) {
          bodyParts.push(c);
          bytes += c.length;
        });
        resp.on('end', function () {
          var body = Buffer.concat(bodyParts, bytes).toString('utf8');
          var json;

          try {
            json = JSON.parse(body);
          } catch (ex) {
            return res.json(500, {
              error: 'There was an error parsing the response from the server'
            });
          }

          if (resp.statusCode !== 200) {
            return res.json(resp.statusCode, json);
          }

          authenticateCallback(null, req, res, json);
        });
      });
      hReq.end(JSON.stringify({
        uid: req.session.user.email,
        password: body.password
      }), 'utf8');
    }
  };

  self.bind = function (app) {
    app.post('/verify', self.handlers.verify);
    app.post('/authenticate', self.handlers.authenticate);
    app.post('/logout', self.handlers.logout);
    app.post('/auth/v2/authenticateToken', self.handlers.authenticateToken);
    app.post('/auth/v2/request', self.handlers.request);
    app.post('/auth/v2/uid-exists', self.handlers.uidExists);
    app.post('/auth/v2/create', self.handlers.createUser);
    app.post('/auth/v2/verify-password', self.handlers.verifyPassword);
    app.post('/auth/v2/request-reset-code', self.handlers.requestResetCode);
    app.post('/auth/v2/reset-password', self.handlers.resetPassword);
    app.post('/auth/v2/remove-password', self.handlers.removePassword);
    app.post('/auth/v2/enable-passwords', self.handlers.enablePasswords);
  };
};
