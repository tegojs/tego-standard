import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, icons } from '@tachybase/client';

import { ColorPicker } from 'antd';

import { iconSize, styleBackgroudColor } from '../../constant';
import { useTranslation } from '../../locale';
import { IconItem } from './IconItem';
import { useStyles } from './SystemIcon.style';

export const SystemIcon = (props) => {
  const { size, setSize, color, setColor } = props;
  const { styles } = useStyles();
  const [activeSection, setActiveSection] = useState('Directional');
  const containerRef = useRef(null);

  const sizeProps = {
    ...props,
    size,
    setSize,
    color,
    setColor,
    activeSection,
    setActiveSection,
    containerRef,
  };

  return (
    <div className={styles.systemIcon}>
      <SystemIconTop {...sizeProps} />
      <SystemIconMiddle {...sizeProps} />
      <SystemIconBottom {...sizeProps} />
    </div>
  );
};

const SystemIconTop = (props) => {
  const { size, setSize, color, setColor } = props;
  const { t } = useTranslation();

  return (
    <div className={'system-icon-top'}>
      <div className={'system-icon-size'}>
        {`${t('Select base color')}`}
        <div className="system-icon-radius">
          <Icon
            type={'clearoutlined'}
            onClick={() => {
              setColor('');
              setSize('');
            }}
          />
          <ul>
            <li
              className={`${size === 'rounded' ? 'syste-icon-checkout' : ''}`}
              onClick={() => {
                setSize('rounded');
              }}
            >
              {t('Rotundity')}
            </li>
            <li
              className={`${size === 'smallRounded' ? 'syste-icon-checkout' : ''}`}
              onClick={() => {
                setSize('smallRounded');
              }}
            >
              {t('Small Rounded')}
            </li>
            <li
              className={`${size === 'largeRounded' ? 'syste-icon-checkout' : ''}`}
              onClick={() => {
                setSize('largeRounded');
              }}
            >
              {t('Large Rounded')}
            </li>
          </ul>
        </div>
      </div>
      <ul className={'system-icon-style'}>
        {styleBackgroudColor.map((item, index) => {
          const isSelected = color === item.background;
          const commonStyle = {
            ...item,
            borderRadius: iconSize[size]?.borderRadius,
            border: isSelected ? '2px solid #1890ff' : '1px solid #d4d4d4',
            boxSizing: 'border-box' as const,
            cursor: 'pointer',
          };
          if (index + 1 === styleBackgroudColor.length) {
            const chekoutColor = styleBackgroudColor.find((colorItem) => colorItem.background === color);
            return (
              <ColorPicker
                style={commonStyle}
                value={chekoutColor ? '' : color}
                onChange={(color) => {
                  setColor(color.toCssString());
                }}
              ></ColorPicker>
            );
          }
          return (
            <li
              style={commonStyle}
              onClick={() => {
                setColor(item.background);
              }}
            ></li>
          );
        })}
      </ul>
    </div>
  );
};

const SystemIconMiddle = (props) => {
  const { filterKey, onChange, size, color, value, setActiveSection, containerRef, setIconName } = props;
  const [clickValue, setClickValue] = useState();
  const { t } = useTranslation();
  const iconKeysByFilter = getFilterKeys(filterKey, icons);
  useEffect(() => {
    const handleScroll = () => {
      const sections = document.querySelectorAll('.system-icon-category');
      const middle = document.getElementById('system-icon-middle');
      const middleRect = middle.getBoundingClientRect();
      let currentSection = 'Application';

      sections.forEach((section) => {
        const rect = section.getBoundingClientRect();

        if (rect.top - middleRect.top <= 70) {
          currentSection = section.id;
        }
      });
      setActiveSection(currentSection);
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
    }

    return () => container?.removeEventListener('scroll', handleScroll);
  }, [setActiveSection]);

  const iconChange = (key) => {
    // const changeProps = {
    //   iconValue:key,
    //   background: color,
    //   borderRadius: iconSize[size]?.borderRadius,
    // };
    // if (color) {
    //   changeProps['color']='white'
    // }
    // onChange(key);
    setIconName(key);
    setClickValue(key);
  };
  return (
    <div className={'system-icon-middle'} ref={containerRef} id="system-icon-middle">
      {t('Select Icon')}
      {Object.keys(iconKeysByFilter).map((item) => {
        return iconKeysByFilter[item].length ? (
          <div className={'system-icon-category'} id={item}>
            <div className="title">{t(item)}</div>
            <div className="icon">
              {iconKeysByFilter[item].map((key) => (
                <IconItem
                  key={key}
                  iconKey={key}
                  selected={key === clickValue}
                  size={iconSize[size]}
                  color={color}
                  onClick={iconChange}
                />
              ))}
            </div>
          </div>
        ) : null;
      })}
    </div>
  );
};

const SystemIconBottom = (props) => {
  const { activeSection, containerRef } = props;

  const handleClick = (id) => {
    const section = document.getElementById(id);
    if (section && containerRef.current) {
      containerRef.current.scrollTo({
        top: section.offsetTop - containerRef.current.offsetTop,
        behavior: 'smooth',
      });
    }
  };
  const categoryIcons = [
    {
      id: 'Directional',
      icon: 'rightcircleoutlined',
    },
    {
      id: 'Suggested',
      icon: 'exclamationcircleoutlined',
    },
    {
      id: 'EditIcon',
      icon: 'editoutlined',
    },
    {
      id: 'DataIcon',
      icon: 'pieChartoutlined',
    },
    {
      id: 'Brand',
      icon: 'globaloutlined',
    },
    {
      id: 'Application',
      icon: 'appstoreoutlined',
    },
  ];
  return (
    <div className={'system-icon-bottom'}>
      <ul>
        {categoryIcons.map((item) => {
          return (
            <li
              className={`system-icon-bottom-li  ${activeSection === item.id ? 'system-icon-bottom-li-active' : ''}`}
              onClick={() => {
                handleClick(item.id);
              }}
            >
              <Icon type={item.icon} />
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const getFilterKeys = (filterKey, icons) => {
  const iconKeysByFilter = useMemo(() => {
    const iconFilter = {
      Directional: [],
      Suggested: [],
      EditIcon: [],
      DataIcon: [],
      Brand: [],
      Application: [],
    };
    const iconsKey = [];
    if (filterKey) {
      icons.keys().forEach((item) => {
        if (item.toLowerCase().includes(filterKey.toLowerCase())) {
          iconsKey.push(item);
        }
      });
    } else {
      iconsKey.push(...icons.keys());
    }
    iconsKey.forEach((iconName) => {
      if (/up|down|left|right|arrow|expand|shrink/.test(iconName)) iconFilter.Directional.push(iconName);
      else if (/check|info|exclamation|close/.test(iconName)) iconFilter.Suggested.push(iconName);
      else if (/edit|delete|copy|save/.test(iconName)) iconFilter.EditIcon.push(iconName);
      else if (/chart|database|table/.test(iconName)) iconFilter.DataIcon.push(iconName);
      else if (/alibaba|antDesign|alipay|taobao|weibo|qq|wechat|github/.test(iconName)) iconFilter.Brand.push(iconName);
      else iconFilter.Application.push(iconName);
    });
    return iconFilter;
  }, [filterKey]);
  return iconKeysByFilter;
};
