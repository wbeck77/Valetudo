const fs = require("fs");
const mqtt = require("mqtt");
const Roborock = require("./devices/Roborock");
const Logger = require("./Logger");

const MQTT_COMMANDS = {
    START: "start",
    RETURN_TO_BASE: "return_to_base",
    STOP: "stop",
    CLEAN_SPOT: "clean_spot",
    LOCATE: "locate",
    PAUSE: "pause"
};

const CUSTOM_COMMANDS = {
    GO_TO: "go_to",
    ZONED_CLEANUP: "zoned_cleanup"
};

//TODO: since this is also displayed in the UI it should be moved somewhere else
const FAN_SPEEDS = {
    "min": 38,
    "medium": 60,
    "high": 75,
    "max": 100,
    "mop": 105
};

/**
 * These mapping maps the xiaomi-specific states to the standardized HA State Vacuum States
 * They can be found here:
 * https://github.com/home-assistant/home-assistant/blob/master/homeassistant/components/vacuum/__init__.py#L58
 *
 */
const HA_STATES = {
    CLEANING: "cleaning",
    PAUSED: "paused",
    IDLE: "idle",
    RETURNING: "returning",
    DOCKED: "docked",
    ERROR: "error",
    ZONE_CLEANUP: "cleaning"
};

// Codes as per Status.js
const HA_STATE_MAPPINGS = {
    "CHARGER_DISCONNECTED": HA_STATES.IDLE,
    "IDLE": HA_STATES.IDLE,
    "CLEANING": HA_STATES.CLEANING,
    "MANUAL_MODE": HA_STATES.CLEANING,
    "SPOT_CLEANING": HA_STATES.CLEANING,
    "GOING_TO_TARGET": HA_STATES.CLEANING,
    "ZONED_CLEANING": HA_STATES.ZONE_CLEANUP,
    "RETURNING_HOME": HA_STATES.RETURNING,
    "DOCKING": HA_STATES.RETURNING,
    "CHARGING": HA_STATES.DOCKED,
    "CHARGING_PROBLEM": HA_STATES.ERROR,
    "ERROR": HA_STATES.ERROR,
    "PAUSED": HA_STATES.PAUSED,
};

class MqttClient {
    /**
     * @param {object} options
     * @param {import("./Configuration")} options.configuration
     * @param {import("./devices/MiioVacuum")} options.vacuum
     * @param {import("./miio/Model")} options.model
     * @param {import("events").EventEmitter} options.events
     * @param {import("./dtos/MapDTO")} options.map
     */
    constructor (options) {
        this.configuration = options.configuration;
        this.vacuum = options.vacuum;
        this.model = options.model;

        let mqttConfig = this.configuration.get("mqtt");

        this.brokerURL = mqttConfig.broker_url;
        this.identifier = mqttConfig.identifier || "rockrobo";
        this.topicPrefix = mqttConfig.topicPrefix || "valetudo";
        this.autoconfPrefix = mqttConfig.autoconfPrefix || "homeassistant";
        this.attributesUpdateInterval = mqttConfig.attributesUpdateInterval || 60000;
        this.provideMapData = mqttConfig.provideMapData !== undefined ? mqttConfig.provideMapData : true;
        this.caPath = mqttConfig.caPath || "";
        this.qos = mqttConfig.qos || 0;
        this.events = options.events;
        this.map = options.map;

        this.topics = {
            command: this.topicPrefix + "/" + this.identifier + "/command",
            set_fan_speed: this.topicPrefix + "/" + this.identifier + "/set_fan_speed",
            send_command: this.topicPrefix + "/" + this.identifier + "/custom_command",
            state: this.topicPrefix + "/" + this.identifier + "/state",
            map_data: this.topicPrefix + "/" + this.identifier + "/map_data",
            attributes: this.topicPrefix + "/" + this.identifier + "/attributes",
            homeassistant_autoconf_vacuum: this.autoconfPrefix + "/vacuum/" + this.topicPrefix + "_" + this.identifier + "/config",
        };

        this.autoconf_payloads = {
            vacuum: {
                name: this.identifier,
                unique_id: this.identifier,
                device: {
                    manufacturer: this.model.getManufacturerName(),
                    model: this.model.getModelName(),
                    name: this.identifier,
                    identifiers: [this.identifier]
                },
                schema: "state",
                supported_features: [
                    "start",
                    "pause",
                    "stop",
                    "return_home",
                    "battery",
                    "status",
                    "locate",
                    "clean_spot",
                    "fan_speed",
                    "send_command"
                ],
                command_topic: this.topics.command,
                state_topic: this.topics.state,
                set_fan_speed_topic: this.topics.set_fan_speed,
                fan_speed_list: Object.keys(FAN_SPEEDS),
                send_command_topic: this.topics.send_command,
                json_attributes_topic: this.topics.attributes
            }
        };

        this.last_ha_state = HA_STATES.IDLE;
        this.last_state = "UNKNOWN";
        this.last_attributes = {};


        this.connect();
        this.updateAttributesTopic();


        this.events.on("valetudo.map", () => {
            if (this.provideMapData) {
                this.updateMapDataTopic(this.map);
            }
        });

        this.events.on("miio.status", (statusData) => {
            this.updateStatusTopic(statusData);
            this.updateAttributesTopicOnEvent(statusData);
        });
    }

    connect() {
        if (!this.client || (this.client && this.client.connected === false && this.client.reconnecting === false)) {
            const options = {};
            if (this.caPath) {
                options.ca = fs.readFileSync(this.caPath);
            }
            this.client = mqtt.connect(this.brokerURL, options);

            this.client.on("connect", () => {
                Logger.info("Connected successfully to mqtt server");
                this.client.subscribe([
                    this.topics.command,
                    this.topics.set_fan_speed,
                    this.topics.send_command
                ], {qos:this.qos}, err => {
                    if (!err) {
                        this.client.publish(this.topics.homeassistant_autoconf_vacuum, JSON.stringify(this.autoconf_payloads.vacuum), {
                            retain: true, qos:this.qos
                        });
                    } else {
                    //TODO: needs more error handling
                        Logger.error(err.toString());
                    }
                });
            });

            this.client.on("message", (topic, message) => {
                let msg = message.toString();
                switch (topic) {
                    case this.topics.send_command:
                        this.handleCustomCommand(msg);
                        break;
                    case this.topics.set_fan_speed:
                        this.handleFanSpeedRequest(msg);
                        break;
                    case this.topics.command:
                        this.handleCommand(msg);
                        break;
                }
            });

            this.client.on("error", (e) => {
                if (e && e.message === "Not supported") {
                    Logger.info("Connected to non standard compliant MQTT Broker.");
                } else {
                    Logger.error(e.toString());
                }
            });
        }
    }

    /**
     *
     * @param {import("./dtos/MapDTO")} mapDTO
     */
    updateMapDataTopic(mapDTO) {
        if (this.client && this.client.connected === true && mapDTO && mapDTO.parsedData) {
            this.client.publish(this.topics.map_data, JSON.stringify(mapDTO.parsedData), {retain: true, qos:this.qos});
        }
    }

    /** @param {import("./miio/Status")} statusData */
    updateAttributesTopicOnEvent(statusData) {
        this.last_ha_state = HA_STATE_MAPPINGS[statusData.state];
        this.last_state = statusData.state;

        this.updateAttributesTopic();
    }

    updateAttributesTopic() {
        if (this.attributesUpdateTimeout) {
            clearTimeout(this.attributesUpdateTimeout);
        }

        if (this.client && this.client.connected === true) {
            this.vacuum.getConsumableStatus()
                .then(res => {
                    var response = {};

                    this.vacuum.getCleanSummary()
                        .then(res2 => {
                            response.cleanTime = (res2[0] / 60 / 60).toFixed(1);
                            response.cleanArea = (res2[1] / 1000000).toFixed(1);
                            response.cleanCount = res2[2];
                            var last_runs = res2[3];
                            if (last_runs.length > 0) {
                                this.vacuum.getCleanRecord(parseInt(last_runs[0]))
                                    .then(data => {
                                        this.last_run_stats = {
                                            startTime: data[0][0] * 1000, //convert to ms
                                            endTime: data[0][1] * 1000, //convert to ms
                                            duration: data[0][2],
                                            area: (data[0][3] / 1000000).toFixed(1),
                                            errorCode: data[0][4],
                                            errorDescription: Roborock.GET_ERROR_CODE_DESCRIPTION(data[0][4]),
                                            finishedFlag: (data[0][5] === 1)
                                        };
                                    }).catch(err => Logger.error(err));
                            }
                            response.last_run_stats = this.last_run_stats ? this.last_run_stats : {};
                            response.mainBrush = (Math.max(0, 300 - (res.main_brush_work_time / 60 / 60))).toFixed(1);
                            response.sideBrush = (Math.max(0, 200 - (res.side_brush_work_time / 60 / 60))).toFixed(1);
                            response.filter = (Math.max(0, 150 - (res.filter_work_time / 60 / 60))).toFixed(1);
                            response.sensor = (Math.max(0, 30 - (res.sensor_dirty_time / 60 / 60))).toFixed(1);
                            response.state = this.last_ha_state;
                            response.valetudo_state = this.last_state;
                            let zoneCleaningStatus = this.vacuum.getZoneCleaningStatus();
                            if (zoneCleaningStatus){
                                response.zoneStatus = zoneCleaningStatus;
                            }

                            if (JSON.stringify(response) !== JSON.stringify(this.last_attributes)) {
                                this.client.publish(this.topics.attributes, JSON.stringify(response), {retain: true, qos:this.qos});
                                this.last_attributes = response;
                            }

                            this.attributesUpdateTimeout = setTimeout(() => {
                                this.updateAttributesTopic();
                            }, this.attributesUpdateInterval);
                        })
                        .catch(err => {
                            Logger.error(err);
                            this.attributesUpdateTimeout = setTimeout(() => {
                                this.updateAttributesTopic();
                            }, this.attributesUpdateInterval);
                        });
                })
                .catch(err => {
                    Logger.error(err);
                    this.attributesUpdateTimeout = setTimeout(() => {
                        this.updateAttributesTopic();
                    }, this.attributesUpdateInterval);
                });
        } else {
            this.attributesUpdateTimeout = setTimeout(() => {
                this.updateAttributesTopic();
            }, this.attributesUpdateInterval);
        }
    }

    /**
     * @param {object} statusData
     * @param {number} statusData.battery
     * @param {number} statusData.state
     * @param {number} statusData.error_code
     * @param {number} statusData.fan_power
     */
    updateStatusTopic(statusData) {
        if (this.client && this.client.connected === true && statusData.battery !== undefined) {
            var response = {};
            response.state = HA_STATE_MAPPINGS[statusData.state];
            response.battery_level = statusData.battery;
            response.fan_speed = Object.keys(FAN_SPEEDS).find(key => FAN_SPEEDS[key] === statusData.fan_power);

            if (statusData.error_code !== undefined && statusData.error_code !== 0) {
                response.error = Roborock.GET_ERROR_CODE_DESCRIPTION(statusData.error_code);
            }

            this.client.publish(this.topics.state, JSON.stringify(response), {retain: true, qos:this.qos});
        }
    }

    /**
     * @param {string} speed
     */
    handleFanSpeedRequest(speed) {
        this.vacuum.setFanSpeed(FAN_SPEEDS[speed]);
    }

    /**
     * @param {string} command
     */
    handleCommand(command) {
        switch (command) { //TODO: error handling
            case MQTT_COMMANDS.START:
                this.vacuum.getCurrentStatus().then(
                    (res) => {
                        if (res.in_cleaning === 2 && HA_STATE_MAPPINGS[res.state] === HA_STATES.PAUSED) {
                            this.vacuum.resumeCleaningZone();
                        } else {
                            this.vacuum.startCleaning();
                        }
                    },
                    (err) => {
                        Logger.error(err);
                    }
                );
                break;
            case MQTT_COMMANDS.STOP:
                this.vacuum.stopCleaning();
                break;
            case MQTT_COMMANDS.RETURN_TO_BASE:
                this.vacuum.stopCleaning().then(() => {
                    this.vacuum.driveHome();
                });
                break;
            case MQTT_COMMANDS.CLEAN_SPOT:
                this.vacuum.spotClean();
                break;
            case MQTT_COMMANDS.LOCATE:
                this.vacuum.findRobot();
                break;
            case MQTT_COMMANDS.PAUSE:
                this.vacuum.pauseCleaning();
                break;
        }
    }

    /**
     * Expects a stringified JSON payload
     * Must contain a field named "command"
     *
     * @param {string} message
     */
    handleCustomCommand(message) {
        let msg;

        try {
            msg = JSON.parse(message);
        } catch (e) {
            Logger.error(e);
        }

        if (msg && msg.command) {
            switch (msg.command) {
                /**
                 * {
                 *   "command": "zoned_cleanup",
                 *   "zone_ids": [
                 *     "Foobar",
                 *     "Baz"
                 *   ]
                 * }
                 * Note: that zone_ids can be a mix of Zone IDs (numbers) and zone names.
                 */
                case CUSTOM_COMMANDS.ZONED_CLEANUP: {
                    const zones = msg["zone_ids"];
                    if (Array.isArray(zones) && zones.length) {
                        const zone_ids = [...this.configuration.getZones().values()]
                            .filter(zone => zones.includes(zone.name) ||
                                            zones.includes(zone.id))
                            .map(zone => zone.id);
                        this.vacuum.startCleaningZonesById(zone_ids).catch(err => {
                            Logger.error(err);
                        });
                    } else {
                        Logger.info("Missing zone_ids or empty array");
                    }
                    break;
                }
                /**
                 * {
                 *   "command": "go_to",
                 *   "spot_id": "Somewhere"
                 * }
                 */
                case CUSTOM_COMMANDS.GO_TO:
                    if (msg.spot_id) {
                        const spots = this.configuration.get("spots");
                        const spot_coords = spots.find(e => Array.isArray(e) && e[0] === msg.spot_id);

                        if (spot_coords) {
                            this.vacuum.goTo(spot_coords[1], spot_coords[2]);
                        } else {
                            Logger.info("Invalid spot_id");
                        }
                    } else {
                        Logger.info("Missing spot_id");
                    }
                    break;
                default:
                    Logger.info("Received invalid custom command", msg.command, msg);
            }
        }
    }

    /**
     * Shutdown MQTT Client
     *
     * @returns {Promise<void>}
     */
    shutdown() {
        return new Promise((resolve, reject) => {
            Logger.debug("Shutting down the MQTT Client...");
            this.client.end(true, () => {
                Logger.debug("Shutting down the MQTT Client done");
                resolve();
            });
        });
    }
}

module.exports = MqttClient;
