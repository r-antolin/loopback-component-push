
var async = require('async');

var PushManager = require('../lib/push-manager');
var Notification = require('../models/notification');
var Application = require('loopback').Application;
var Device = require('../models/device');

var expect = require('chai').expect;
var sinon = require('sinon');
var mockery = require('./helpers/mockery').stub;
var TestDataBuilder = require('loopback-testing').TestDataBuilder;
var ref = TestDataBuilder.ref;

describe('PushManager', function() {
  beforeEach(mockery.setUp);
  beforeEach(Application.deleteAll.bind(Application));
  beforeEach(Device.deleteAll.bind(Device));
  afterEach(mockery.tearDown);

  var pushManager;
  var context;

  beforeEach(function(done) {
    pushManager = new PushManager();
    context = {};
    new TestDataBuilder()
      .define('notification', Notification)
      .buildTo(context, done);
  });

  it('deletes devices no longer registered', function(done) {
    async.series([
      function arrange(cb) {
        new TestDataBuilder()
          .define('application', Application, {
            pushSettings: { stub: { } }
          })
          .define('device', Device, {
            appId: ref('application.id'),
            deviceType: mockery.deviceType
          })
          .buildTo(context, cb);
      },

      function configureProvider(cb) {
        pushManager.configureApplication(
          context.device.appId,
          context.device.deviceType,
          cb);
      },

      function act(cb) {
        mockery.emitDevicesGone(context.device.deviceToken);

        // Wait until the feedback is processed
        // We can use process.nextTick because Memory store
        // deletes the data within this event loop
        process.nextTick(cb);
      },

      function verify(cb) {
        Device.find(function(err, result) {
          if (err) return cb(err);
          expect(result).to.have.length(0);
          cb();
        });
      }
    ], done);
  });

  describe('.notifyById', function() {
    it('sends notification to the correct device', function(done) {
      async.series([
        function arrange(cb) {
          new TestDataBuilder()
            .define('application', Application, {
              pushSettings: { stub: { } }
            })
            // Note: the order in which the devices are created is important.
            // The device that should not receive the notification must
            // be created first. This way the test fails when PushManager
            // looks up the device via `Device.findOne({ deviceToken: token })`.
            .define('anotherDevice', Device, {
              appId: ref('application.id'),
              deviceToken: 'a-device-token',
              deviceType: 'another-device-type'
            })
            .define('device', Device, {
              appId: ref('application.id'),
              deviceToken: 'a-device-token',
              deviceType: mockery.deviceType
            })
            .buildTo(context, cb);
        },

        function act(cb) {
          pushManager.notifyById(
            context.device.id,
            context.notification,
            cb
          );
        },

        function verify(cb) {
          // Wait with the check to give the push manager some time
          // to load all data and push the message
          setTimeout(function() {
            expect(mockery.firstPushNotificationArgs()).to.deep.equal(
              [context.notification, context.device.deviceToken]
            );
            cb();
          }, 50);
        }
      ], done);
    });

    it('reports error when device was not found', function(done) {
      async.series([
        function actAndVerify(cb) {
          pushManager.notifyById(
            'unknown-device-id',
            context.notification,
            verify
          );

          function verify(err) {
            expect(err).to.be.instanceOf(Error);
            expect(err.details)
              .to.have.property('deviceId', 'unknown-device-id');
            cb();
          }
        }
      ], done);
    });

    it('reports error when application was not found', function(done) {
      async.series([
        function arrange(cb) {
          new TestDataBuilder()
            .define('device', Device, { appId: 'unknown-app-id' })
            .buildTo(context, cb);
        },

        function actAndVerify(cb) {
          pushManager.notifyById(
            context.device.id,
            context.notification,
            verify
          );

          function verify(err) {
            expect(err).to.be.instanceOf(Error);
            expect(err.details)
              .to.have.property('appId', 'unknown-app-id');
            cb();
          }
        }
      ], done);
    });

    it('reports error when application has no pushSettings', function(done) {
      async.series([
        function arrange(cb) {
          new TestDataBuilder()
            .define('application', Application, { pushSettings: null })
            .define('device', Device, {
              appId: ref('application.id'),
              deviceType: 'unknown-device-type'
            })
            .buildTo(context, cb);
        },

        function actAndVerify(cb) {
          pushManager.notifyById(
            context.device.id,
            context.notification,
            verify
          );

          function verify(err) {
            expect(err).to.be.instanceOf(Error);
            expect(err.details).to.have.property('application');
            cb();
          }
        }
      ], done);

    });

    it('reports error for unknown device type', function(done) {
      async.series([
        function arrange(cb) {
          new TestDataBuilder()
            .define('application', Application, { pushSettings: {}})
            .define('device', Device, {
              appId: ref('application.id'),
              deviceType: 'unknown-device-type'
            })
            .buildTo(context, cb);
        },

        function actAndVerify(cb) {
          pushManager.notifyById(
            context.device.id,
            context.notification,
            verify
          );

          function verify(err) {
            expect(err).to.be.instanceOf(Error);
            cb();
          }
        }
      ], done);

    });

    it('emits error when push fails inside provider', function(done) {
      async.series([
        function arrange(cb) {
          new TestDataBuilder()
            .define('application', Application, {
              pushSettings: { stub: { } }
            })
            .define('device', Device, {
              appId: ref('application.id'),
              deviceToken: 'a-device-token',
              deviceType: mockery.deviceType
            })
            .buildTo(context, cb);
        },

        function actAndVerify(cb) {
          var errorCallback = sinon.spy();
          pushManager.on('error', errorCallback);

          mockery.pushNotification = function() {
            this.emit('error', new Error('a test error'));
          };

          pushManager.notifyById(
            context.device.id,
            context.notification,
            function(err) {
              if (err) throw err;
              expect(errorCallback.calledOnce, 'error was emitted')
                .to.equal(true);
              cb();
            }
          );
        }
      ], done);
    });
  });

  describe('.notifyByQuery', function() {
    it('sends notifications to the correct devices', function(done) {
      async.series([
        function arrange(cb) {
          new TestDataBuilder()
            .define('application', Application, {
              pushSettings: { stub: { } }
            })
            .define('myPhone', Device, {
              appId: ref('application.id'),
              deviceToken: 'my-phone-token',
              deviceType: mockery.deviceType,
              userId: 'myself'
            })
            .define('myOtherPhone', Device, {
              appId: ref('application.id'),
              deviceToken: 'my-other-phone-token',
              deviceType: mockery.deviceType,
              userId: 'myself'
            })
            .define('friendsPhone', Device, {
              appId: ref('application.id'),
              deviceToken: 'friends-phone-token',
              deviceType: mockery.deviceType,
              userId: 'somebody else'
            })
            .buildTo(context, cb);
        },

        function act(cb) {
          pushManager.notifyByQuery(
            { userId: 'myself' },
            context.notification,
            cb
          );
        },

        function verify(cb) {
          // Wait with the check to give the push manager some time
          // to load all data and push the message
          setTimeout(function() {
            var callsArgs = mockery.pushNotification.args;
            expect(callsArgs, 'number of notifications').to.have.length(2);
            expect(callsArgs[0]).to.deep.equal(
              [context.notification, context.myPhone.deviceToken]
            );
            expect(callsArgs[1]).to.deep.equal(
              [context.notification, context.myOtherPhone.deviceToken]
            );
            cb();
          }, 50);
        }
      ], done);
    });
  });
});