/**
 * Created by vedi on 01/02/16.
 */
module.exports = function (self) {
  return function (options) {

    options.backendPrefix = options.backendPrefix || 'backend';

    // extracts the part after first subdomain
    var regexp = new RegExp('^' + options.prefix + '\.(.*$)', 'i');

    return function (req, res, next) {
      var host = req.get('host');

      var found = host.match(regexp);
      
      if (found) {
        var whitelabelDomain = found[1];

        var urlPrefix = self.forceSSL ? 'https://' : 'http://';

        req.whitelabel = {
          domain: whitelabelDomain,
          cookieDomain: '.' + whitelabelDomain,
          getBackendUrl: function () {
            return urlPrefix + options.backendPrefix + this.cookieDomain;
          },
          getApiUrl: function () {
            return urlPrefix + options.apiPrefix + this.cookieDomain;
          },
          getLoginUrl: function () {
            return urlPrefix + options.loginPrefix + this.cookieDomain;
          },
          getLoginUrlWithAuth: function () {
            return urlPrefix + options.loginUsername + ':' + options.loginPassword + '@' +
              options.loginPrefix + this.cookieDomain;
          },
          getEditorUrl: function () {
            return urlPrefix + options.editorPrefix + this.cookieDomain;
          },
          getProjectsUrl: function () {
            return urlPrefix + options.projectsPrefix + this.cookieDomain;
          }
        };
      }

      next();
    }
  }
};